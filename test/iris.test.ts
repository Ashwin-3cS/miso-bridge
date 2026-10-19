import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { decodeBurnMessage } from "@misofm/cctp-forwarders/cctp-v2"
import type { Db } from "../src/db.js"
import { openJournal, type Journal } from "../src/journal.js"
import { irisOnce } from "../src/workers/iris.js"
import { openIsolatedDb, truncateAll } from "./helpers/db.js"

/**
 * The Iris poller against the sibling repo's captured responses: a real
 * Circle attestation for a real Avalanche mainnet burn that was really
 * received on Sui. Mocking the message would test the mock; replaying this
 * tests the byte layout Circle actually produces.
 */

const url = process.env.DATABASE_URL

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../vendor/cctp-forwarders/fixtures/cctp-v2/iris-avalanche.json",
        import.meta.url
      )
    ),
    "utf8"
  )
) as {
  sourceTxHash: string
  byTransactionHash: { httpStatus: number; body: { messages: unknown[] } }
}

const body = fixture.byTransactionHash.body
const entry = body.messages[0] as {
  message: string
  attestation: string
  status: string
}
const decoded = decodeBurnMessage(
  Uint8Array.from(Buffer.from(entry.message.slice(2), "hex"))
)
/** The burn's depositor, which stands in for the forwarder in this capture. */
const FORWARDER = "0x" + decoded.messageSender.slice(26)
const RECIPIENT = decoded.mintRecipient

/** Replaces `bytes` in the message at a byte offset, keeping the length. */
function tamper(messageHex: string, offset: number, bytes: string): string {
  const hex = messageHex.slice(2)
  const at = offset * 2
  return "0x" + hex.slice(0, at) + bytes + hex.slice(at + bytes.length)
}

const responder = (status: number, payload?: unknown) =>
  (async () =>
    new Response(status === 404 ? "not found" : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch

describe.skipIf(!url)("irisOnce", () => {
  let db: Db
  let journal: Journal

  beforeAll(async () => {
    db = await openIsolatedDb(url as string, "iris_test")
    journal = openJournal(db, "mainnet")
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    await journal.bindRecipient({ suiAddress: RECIPIENT, userRef: "user-1" })
    const deposit = await journal.issueDeposit({
      suiAddress: RECIPIENT,
      chain: "avalanche",
      forwarderAddress: FORWARDER,
    })
    await journal.recordBurn({
      depositId: deposit.id,
      chain: "avalanche",
      txHash: fixture.sourceTxHash,
      burnIndex: 0,
      blockNumber: 97_000_574n,
      amount: decoded.amount,
    })
  })

  const run = (fetchFn: typeof fetch) =>
    irisOnce({ journal, fetchFn, chain: "avalanche" })

  it("the capture really is a Sui-bound burn by this depositor", () => {
    expect(decoded.sourceDomain).toBe(1)
    expect(entry.status).toBe("complete")
    expect(decoded.amount).toBeGreaterThan(0n)
    expect(RECIPIENT).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("validates the real attested message", async () => {
    const outcomes = await run(responder(200, body))
    expect(outcomes).toEqual([
      { burnId: expect.any(String), kind: "validated", nonce: decoded.nonce },
    ])
    const [validated] = await journal.burnsByStatus("validated", 10)
    expect(validated?.nonce).toBe(decoded.nonce)
    expect(validated?.maxFee).toBe(decoded.maxFee)
    expect(validated?.feeExecuted).toBe(decoded.feeExecuted)
    // Stored byte for byte: the mint has to submit exactly what Circle signed.
    expect(Buffer.from(validated?.message ?? []).toString("hex")).toBe(
      entry.message.slice(2)
    )
    expect(Buffer.from(validated?.attestation ?? []).toString("hex")).toBe(
      entry.attestation.slice(2)
    )
  })

  it("treats a 404 as not indexed yet, not as an error", async () => {
    expect(await run(responder(404))).toEqual([
      { burnId: expect.any(String), kind: "not-indexed" },
    ])
    expect((await journal.burnsByStatus("attesting", 10)).length).toBe(1)
  })

  it("waits while Circle is still collecting confirmations", async () => {
    const pending = {
      messages: [
        { status: "pending_confirmations", message: "0x", attestation: null },
      ],
    }
    expect(await run(responder(200, pending))).toEqual([
      { burnId: expect.any(String), kind: "pending", delayReason: null },
    ])
    expect((await journal.burnsByStatus("validated", 10)).length).toBe(0)
  })

  it("keeps polling when the transaction carries someone else's CCTP message", async () => {
    // A complete message whose messageSender is not this forwarder. It is not
    // ours to reject: the message we want may simply not be signed yet.
    const other = {
      messages: [
        {
          ...entry,
          message: tamper(
            entry.message,
            248,
            "00".repeat(12) + "ee".repeat(20)
          ),
        },
      ],
    }
    expect(await run(responder(200, other))).toMatchObject([
      { kind: "pending" },
    ])
    expect((await journal.burnsByStatus("quarantined", 10)).length).toBe(0)
  })

  it("quarantines a message that claims this forwarder but is not its burn", async () => {
    const tampered = {
      messages: [
        { ...entry, message: tamper(entry.message, 184, "ab".repeat(32)) },
      ],
    }
    const outcomes = await run(responder(200, tampered))
    expect(outcomes[0]).toMatchObject({ kind: "quarantined" })
    const [quarantined] = await journal.burnsByStatus("quarantined", 10)
    expect(quarantined?.problem).toContain("differs from the forwarder's burn")
    // Terminal: the schema will not let a mint reference it.
    expect((await journal.burnsByStatus("validated", 10)).length).toBe(0)
  })

  it("picks our message out of a transaction with several", async () => {
    const mixed = {
      messages: [
        {
          ...entry,
          message: tamper(
            entry.message,
            248,
            "00".repeat(12) + "ee".repeat(20)
          ),
        },
        entry,
      ],
    }
    expect(await run(responder(200, mixed))).toMatchObject([
      { kind: "validated" },
    ])
  })

  it("re-polls a burn it has already marked attesting", async () => {
    await run(responder(404))
    expect((await journal.burnsByStatus("attesting", 10)).length).toBe(1)
    expect(await run(responder(200, body))).toMatchObject([
      { kind: "validated" },
    ])
  })

  it("does not touch burns from another chain", async () => {
    expect(
      await irisOnce({
        journal,
        fetchFn: responder(200, body),
        chain: "polygon",
      })
    ).toEqual([])
  })
})
