import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest"
import { type Db } from "../src/db.js"
import { openJournal, type Journal } from "../src/journal.js"
import { openIsolatedDb, truncateAll } from "./helpers/db.js"

/**
 * The journal against a real Postgres. The constraints and triggers it relies
 * on are the point, so a mock would test nothing; these run only when
 * DATABASE_URL is set (`bun run test:db`), and CI's unit run stays offline.
 */

const url = process.env.DATABASE_URL
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const RECIPIENT =
  "0x1111111111111111111111111111111111111111111111111111111111111111"
const FORWARDER = "0x3333333333333333333333333333333333333333"
const TX = "0x4444444444444444444444444444444444444444444444444444444444444444"
const NONCE =
  "0x5555555555555555555555555555555555555555555555555555555555555555"

describe.skipIf(!url)("journal", () => {
  let db: Db
  let journal: Journal

  beforeAll(async () => {
    db = await openIsolatedDb(url as string, "journal_test")
    journal = openJournal(db, "testnet")
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    await journal.bindRecipient({ suiAddress: RECIPIENT, userRef: "user-1" })
  })

  const issue = () =>
    journal.issueDeposit({
      suiAddress: RECIPIENT,
      chain: "avalanche",
      forwarderAddress: FORWARDER,
    })

  describe("issuing an address", () => {
    it("is idempotent: the address is derived, never chosen", async () => {
      const first = await issue()
      const second = await issue()
      expect(second.id).toBe(first.id)
      expect(second.forwarderAddress).toBe(FORWARDER.toLowerCase())
      const { rowCount } = {
        rowCount: (await db.query("select 1 from deposits")).length,
      }
      expect(rowCount).toBe(1)
    })

    it("refuses to reissue a live deposit at a different address", async () => {
      await issue()
      await expect(
        journal.issueDeposit({
          suiAddress: RECIPIENT,
          chain: "avalanche",
          forwarderAddress: "0x9999999999999999999999999999999999999999",
        })
      ).rejects.toThrow("refusing to reissue")
    })

    it("normalises hex to lowercase, so no row can be duplicated by case", async () => {
      const lower = await issue()
      const upper = await journal.issueDeposit({
        suiAddress: RECIPIENT.toUpperCase().replace("0X", "0x"),
        chain: "avalanche",
        forwarderAddress: FORWARDER.toUpperCase().replace("0X", "0x"),
      })
      expect(upper.id).toBe(lower.id)
    })

    it("rejects a recipient that is not 32 bytes", async () => {
      await expect(
        journal.bindRecipient({ suiAddress: "0xdeadbeef", userRef: "u" })
      ).rejects.toThrow("32 bytes of hex")
    })
  })

  describe("balances and cranking", () => {
    it("becomes fundable at the floor and goes back when drained", async () => {
      const deposit = await issue()
      expect(
        await journal.recordBalance({
          depositId: deposit.id,
          balance: 500_000n,
          floor: 1_000_000n,
        })
      ).toBe("issued")
      expect(
        await journal.recordBalance({
          depositId: deposit.id,
          balance: 1_000_000n,
          floor: 1_000_000n,
        })
      ).toBe("fundable")
      expect(
        await journal.recordBalance({
          depositId: deposit.id,
          balance: 0n,
          floor: 1_000_000n,
        })
      ).toBe("issued")
    })

    it("claims a fundable deposit once, counting the attempt", async () => {
      const deposit = await issue()
      await journal.recordBalance({
        depositId: deposit.id,
        balance: 5_000_000n,
        floor: 1n,
      })
      const claimed = await journal.claimForCrank(deposit.id)
      expect(claimed?.status).toBe("cranking")
      expect(claimed?.crankAttempts).toBe(1)
      // Already cranking: a second worker must not pay gas for the same address.
      expect(await journal.claimForCrank(deposit.id)).toBeNull()
    })

    it("does not claim while another worker holds the lock", async () => {
      const deposit = await issue()
      await journal.recordBalance({
        depositId: deposit.id,
        balance: 5_000_000n,
        floor: 1n,
      })
      const held = db.withLock(`crank:${deposit.id}`, async () => {
        await sleep(300)
        return "held"
      })
      await sleep(50)
      expect(await journal.claimForCrank(deposit.id)).toBeNull()
      expect(await held).toBe("held")
    })

    it("treats a Circle refusal as a reason to wait, and retries after it", async () => {
      const deposit = await issue()
      await journal.recordBalance({
        depositId: deposit.id,
        balance: 5_000_000n,
        floor: 1n,
      })
      await journal.claimForCrank(deposit.id)
      await journal.markWaiting(deposit.id, "circle: burn paused")
      const waiting = await journal.findDeposit({
        suiAddress: RECIPIENT,
        chain: "avalanche",
      })
      expect(waiting?.status).toBe("waiting")
      expect(waiting?.waitingReason).toBe("circle: burn paused")
      const retried = await journal.claimForCrank(deposit.id)
      expect(retried?.status).toBe("cranking")
      expect(retried?.crankAttempts).toBe(2)
    })
  })

  describe("burns", () => {
    const record = async (depositId: string) =>
      journal.recordBurn({
        depositId,
        chain: "avalanche",
        txHash: TX,
        logIndex: 0,
        blockNumber: 1_000n,
        amount: 7_000_000n,
      })

    it("is the only evidence a crank happened", async () => {
      const deposit = await issue()
      await journal.recordBalance({
        depositId: deposit.id,
        balance: 7_000_000n,
        floor: 1n,
      })
      await journal.claimForCrank(deposit.id)
      const { burn, isNew } = await record(deposit.id)
      expect(isNew).toBe(true)
      expect(burn.status).toBe("discovered")
      expect(burn.amount).toBe(7_000_000n)
      const after = await journal.findDeposit({
        suiAddress: RECIPIENT,
        chain: "avalanche",
      })
      expect(after?.status).toBe("cranked")
    })

    it("replays without creating a second burn", async () => {
      const deposit = await issue()
      const first = await record(deposit.id)
      const second = await record(deposit.id)
      expect(second.isNew).toBe(false)
      expect(second.burn.id).toBe(first.burn.id)
      expect((await db.query("select 1 from burns")).length).toBe(1)
    })

    it("validates an attested message and records the nonce", async () => {
      const deposit = await issue()
      const { burn } = await record(deposit.id)
      await journal.markAttesting(burn.id, "insufficient_fee")
      await journal.recordAttestation({
        burnId: burn.id,
        nonce: NONCE,
        message: new Uint8Array(376),
        attestation: new Uint8Array(65).fill(0xab),
        maxFee: 0n,
        feeExecuted: 0n,
      })
      const [validated] = await journal.burnsByStatus("validated", 10)
      expect(validated?.nonce).toBe(NONCE)
      expect(validated?.message?.length).toBe(376)
      expect(validated?.attestation?.length).toBe(65)
    })

    it("refuses to record an attestation whose fee exceeds 1%", async () => {
      const deposit = await issue()
      const { burn } = await record(deposit.id)
      await expect(
        journal.recordAttestation({
          burnId: burn.id,
          nonce: NONCE,
          message: new Uint8Array(376),
          attestation: new Uint8Array(65),
          maxFee: 1_000_000n, // amount is 7 USDC
          feeExecuted: 0n,
        })
      ).rejects.toThrow(/fee_within_one_percent/)
    })

    it("quarantines a message that is not this forwarder's burn", async () => {
      const deposit = await issue()
      const { burn } = await record(deposit.id)
      await journal.quarantineBurn(
        burn.id,
        "differs from the forwarder's burn at byte 184"
      )
      const [quarantined] = await journal.burnsByStatus("quarantined", 10)
      expect(quarantined?.problem).toContain("byte 184")
      // Terminal: it can never be minted, by any route.
      await expect(
        journal.claimForMint({ ...burn, nonce: NONCE })
      ).rejects.toThrow()
    })
  })

  describe("minting, exactly once", () => {
    const validated = async () => {
      const deposit = await issue()
      const { burn } = await journal.recordBurn({
        depositId: deposit.id,
        chain: "avalanche",
        txHash: TX,
        logIndex: 0,
        blockNumber: 1_000n,
        amount: 7_000_000n,
      })
      await journal.recordAttestation({
        burnId: burn.id,
        nonce: NONCE,
        message: new Uint8Array(376),
        attestation: new Uint8Array(65),
        maxFee: 0n,
        feeExecuted: 0n,
      })
      const [row] = await journal.burnsByStatus("validated", 1)
      return row as NonNullable<typeof row>
    }

    it("claims, submits and confirms", async () => {
      const burn = await validated()
      const mint = await journal.claimForMint(burn)
      expect(mint?.attempts).toBe(1)
      await journal.markMintSubmitted(NONCE, "digest-1")
      await journal.markMintConfirmed({
        nonce: NONCE,
        burnId: burn.id,
        suiTxDigest: "digest-1",
      })
      const [minted] = await journal.burnsByStatus("minted", 10)
      expect(minted?.id).toBe(burn.id)
    })

    it("cannot be claimed twice once confirmed", async () => {
      const burn = await validated()
      await journal.claimForMint(burn)
      await journal.markMintSubmitted(NONCE, "digest-1")
      await journal.markMintConfirmed({
        nonce: NONCE,
        burnId: burn.id,
        suiTxDigest: "digest-1",
      })
      expect(await journal.claimForMint(burn)).toBeNull()
      expect((await db.query("select 1 from mints")).length).toBe(1)
    })

    it("does not claim while another worker holds the nonce", async () => {
      const burn = await validated()
      const held = db.withLock(`mint:${NONCE}`, async () => {
        await sleep(300)
        return "held"
      })
      await sleep(50)
      expect(await journal.claimForMint(burn)).toBeNull()
      expect(await held).toBe("held")
    })

    it("returns a released message to validated, never dropping it", async () => {
      const burn = await validated()
      await journal.claimForMint(burn)
      await journal.releaseMint({
        nonce: NONCE,
        burnId: burn.id,
        error: "sui: timeout",
      })
      const [back] = await journal.burnsByStatus("validated", 10)
      expect(back?.id).toBe(burn.id)
      const retried = await journal.claimForMint(
        back as NonNullable<typeof back>
      )
      expect(retried?.attempts).toBe(2)
      expect(retried?.lastError).toBe("sui: timeout")
    })

    it("accepts delivery by another caller, with no mint row of ours", async () => {
      const burn = await validated()
      await journal.markDeliveredElsewhere(burn.id, NONCE)
      const [minted] = await journal.burnsByStatus("minted", 10)
      expect(minted?.id).toBe(burn.id)
      expect((await db.query("select 1 from mints")).length).toBe(0)
    })

    it("keeps a minted burn as settled history", async () => {
      const burn = await validated()
      await journal.claimForMint(burn)
      await journal.markMintSubmitted(NONCE, "digest-1")
      await journal.markMintConfirmed({
        nonce: NONCE,
        burnId: burn.id,
        suiTxDigest: "digest-1",
      })
      await expect(
        journal.quarantineBurn(burn.id, "too late")
      ).rejects.toThrow()
    })
  })

  describe("cursors and alerts", () => {
    it("never rewinds a cursor", async () => {
      expect(
        await journal.advanceCursor({
          name: "discover",
          chain: "polygon",
          block: 100n,
        })
      ).toBe(100n)
      expect(
        await journal.advanceCursor({
          name: "discover",
          chain: "polygon",
          block: 90n,
        })
      ).toBe(100n)
      expect(await journal.cursor("discover", "polygon")).toBe(100n)
      expect(await journal.cursor("discover", "avalanche")).toBeNull()
    })

    it("opens an alert once and closes it once", async () => {
      expect(
        await journal.openAlert({ kind: "stalled", subject: "burn:1" })
      ).toBe(true)
      expect(
        await journal.openAlert({ kind: "stalled", subject: "burn:1" })
      ).toBe(false)
      expect(await journal.openAlerts()).toEqual([
        { kind: "stalled", subject: "burn:1" },
      ])
      await journal.closeAlert("stalled", "burn:1")
      expect(await journal.openAlerts()).toEqual([])
      expect(
        await journal.openAlert({ kind: "stalled", subject: "burn:1" })
      ).toBe(true)
    })
  })

  describe("the audit trail", () => {
    it("records every move with its evidence", async () => {
      const deposit = await issue()
      await journal.recordBalance({
        depositId: deposit.id,
        balance: 7_000_000n,
        floor: 1n,
      })
      await journal.claimForCrank(deposit.id)
      const history = await journal.history("deposit", deposit.id)
      expect(history.map((h) => `${h.from}->${h.to}`)).toEqual([
        "issued->fundable",
        "fundable->cranking",
      ])
      expect(history[0]?.evidence).toMatchObject({ balance: "7000000" })
    })

    it("refuses an illegal move with a message naming the legal ones", async () => {
      const deposit = await issue()
      const { burn } = await journal.recordBurn({
        depositId: deposit.id,
        chain: "avalanche",
        txHash: TX,
        logIndex: 0,
        blockNumber: 1n,
        amount: 7_000_000n,
      })
      await expect(journal.markReconciled(burn.id, {})).rejects.toThrow(
        "burn cannot move discovered -> reconciled"
      )
    })
  })
})

describe.skipIf(url)("journal (skipped)", () => {
  it("needs DATABASE_URL; run `bun run test:db`", () => {
    expect(url).toBeUndefined()
  })
})
