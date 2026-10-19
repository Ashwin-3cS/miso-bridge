import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { SuiMinter } from "../src/chain/sui.js"
import type { Db } from "../src/db.js"
import { openJournal, type Journal } from "../src/journal.js"
import { mintOnce } from "../src/workers/mint.js"
import { openIsolatedDb, truncateAll } from "./helpers/db.js"

/**
 * The mint worker against a real journal and a scripted Sui.
 *
 * The journal is real because exactly-once lives in its constraints, not in
 * the worker: the mints table is keyed by nonce, so a second mint of one
 * transfer cannot be represented. What is asserted here is that every branch
 * ends by consulting the nonce rather than by trusting what the worker
 * believes happened.
 */

const url = process.env.DATABASE_URL
const SUI_ADDRESS = "0x" + "7".repeat(64)
const FORWARDER = "0x" + "a".repeat(40)
const TX = "0x" + "b".repeat(64)
const NONCE = "0x" + "c".repeat(64)
const DIGEST = "digest-1"

type Script = {
  nonceUsed?: boolean[] | boolean
  simulate?: { ok: boolean; error?: string }
  submit?: Awaited<ReturnType<SuiMinter["submit"]>> | Error
}

function scriptedSui(script: Script) {
  const reads = Array.isArray(script.nonceUsed)
    ? [...script.nonceUsed]
    : [script.nonceUsed ?? false]
  const nonceReads: boolean[] = []
  const sui = {
    address: "0x" + "9".repeat(64),
    nonceUsed: vi.fn(async () => {
      const value =
        reads.length > 1 ? (reads.shift() as boolean) : (reads[0] as boolean)
      nonceReads.push(value)
      return value
    }),
    simulate: vi.fn(async () => script.simulate ?? { ok: true }),
    submit: vi.fn(async () => {
      if (script.submit instanceof Error) throw script.submit
      return script.submit ?? { status: "minted" as const, digest: DIGEST }
    }),
    gasBalance: vi.fn(async () => 10n ** 9n),
  } as unknown as SuiMinter
  return { sui, nonceReads }
}

describe.skipIf(!url)("mintOnce", () => {
  let db: Db
  let journal: Journal

  beforeAll(async () => {
    db = await openIsolatedDb(url as string, "mint_test")
    journal = openJournal(db, "mainnet")
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    await journal.bindRecipient({ suiAddress: SUI_ADDRESS, userRef: "user-1" })
    const deposit = await journal.issueDeposit({
      suiAddress: SUI_ADDRESS,
      chain: "avalanche",
      forwarderAddress: FORWARDER,
    })
    const { burn } = await journal.recordBurn({
      depositId: deposit.id,
      chain: "avalanche",
      txHash: TX,
      burnIndex: 0,
      blockNumber: 1_000n,
      amount: 7_000_000n,
    })
    await journal.recordAttestation({
      burnId: burn.id,
      nonce: NONCE,
      message: new Uint8Array(376),
      attestation: new Uint8Array(65).fill(0xab),
      maxFee: 0n,
      feeExecuted: 0n,
    })
  })

  /**
   * Lazy on purpose. An earlier version started mintOnce here and handed back
   * the promise, so a test that only wanted the scripted Sui left a run
   * in flight; its open transaction then deadlocked against the next
   * truncate.
   */
  const run = (script: Script) => {
    const { sui, nonceReads } = scriptedSui(script)
    return { sui, nonceReads, outcomes: () => mintOnce({ journal, sui }) }
  }

  it("mints and confirms from the nonce, not from the receipt", async () => {
    const r = run({ nonceUsed: [false, true] })
    expect(await r.outcomes()).toMatchObject([
      { kind: "minted", nonce: NONCE, digest: DIGEST },
    ])
    const [minted] = await journal.burnsByStatus("minted", 10)
    expect(minted?.nonce).toBe(NONCE)
    const mint = await journal.mintByNonce(NONCE)
    expect(mint).toMatchObject({ status: "confirmed", suiTxDigest: DIGEST })
    // Read before submitting, and again to confirm.
    expect(r.nonceReads).toEqual([false, true])
  })

  it("does not spend anything when someone else already delivered it", async () => {
    const r = run({ nonceUsed: true })
    expect(await r.outcomes()).toMatchObject([
      { kind: "delivered", by: "another caller" },
    ])
    expect(r.sui.simulate).not.toHaveBeenCalled()
    expect(r.sui.submit).not.toHaveBeenCalled()
    const [minted] = await journal.burnsByStatus("minted", 10)
    expect(minted?.nonce).toBe(NONCE)
    // mints records our own completed submissions; this was not one.
    expect(await journal.mintByNonce(NONCE)).toBeNull()
  })

  it("returns a message to validated when simulation aborts", async () => {
    const r = run({
      nonceUsed: false,
      simulate: { ok: false, error: "deny list: recipient blocked" },
    })
    expect(await r.outcomes()).toMatchObject([
      { kind: "retry", error: "deny list: recipient blocked" },
    ])
    expect(r.sui.submit).not.toHaveBeenCalled()
    const [back] = await journal.burnsByStatus("validated", 10)
    expect(back?.nonce).toBe(NONCE)
    expect((await journal.mintByNonce(NONCE))?.lastError).toContain("deny list")
  })

  it("retries after an abort on chain", async () => {
    const r = run({
      nonceUsed: false,
      submit: { status: "aborted", digest: DIGEST, error: "EDenied" },
    })
    expect(await r.outcomes()).toMatchObject([{ kind: "retry" }])
    expect((await journal.burnsByStatus("validated", 10)).length).toBe(1)
  })

  it("treats a thrown submit whose nonce then reads used as delivered", async () => {
    // The one case a naive worker gets wrong: the transaction landed, the
    // answer never came back.
    const r = run({
      nonceUsed: [false, true],
      submit: new Error("connection reset"),
    })
    expect(await r.outcomes()).toMatchObject([
      { kind: "delivered", by: "an uncertain submission of ours" },
    ])
    expect((await journal.burnsByStatus("minted", 10)).length).toBe(1)
  })

  it("retries a thrown submit whose nonce still reads unused", async () => {
    const r = run({ nonceUsed: false, submit: new Error("connection reset") })
    expect(await r.outcomes()).toMatchObject([{ kind: "retry" }])
    expect((await journal.burnsByStatus("validated", 10)).length).toBe(1)
  })

  it("refuses to confirm a success the nonce does not support", async () => {
    const r = run({ nonceUsed: false })
    expect(await r.outcomes()).toMatchObject([
      { kind: "retry", error: expect.stringContaining("nonce reads unused") },
    ])
    expect((await journal.burnsByStatus("minted", 10)).length).toBe(0)
  })

  it("counts attempts across retries and never drops the message", async () => {
    await run({ nonceUsed: false }).outcomes()
    await run({ nonceUsed: false }).outcomes()
    expect((await journal.mintByNonce(NONCE))?.attempts).toBe(2)
    expect((await journal.burnsByStatus("validated", 10)).length).toBe(1)
  })

  it("cannot mint the same transfer twice", async () => {
    await mintOnce({ journal, sui: run({ nonceUsed: [false, true] }).sui })
    const second = await mintOnce({
      journal,
      sui: run({ nonceUsed: true }).sui,
    })
    // Already minted, so it is no longer validated and is not even considered.
    expect(second).toEqual([])
    expect((await db.query("select 1 from mints")).length).toBe(1)
  })

  it("never mints a quarantined burn", async () => {
    const [validated] = await journal.burnsByStatus("validated", 1)
    await db.query(
      "update burns set status = 'quarantined', problem = 'tampered' where id = $1",
      [validated?.id]
    )
    expect(
      await mintOnce({ journal, sui: run({ nonceUsed: false }).sui })
    ).toEqual([])
  })
})
