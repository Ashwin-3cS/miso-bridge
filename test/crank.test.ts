import type { Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { EvmRpc } from "../src/chain/evm.js"
import type { Signer } from "../src/chain/signer.js"
import type { DepositRow, Journal } from "../src/journal.js"
import { crankOnce } from "../src/workers/crank.js"

/**
 * The crank with every outside edge injected. What is asserted is not just the
 * happy path but the restraint: it must never record a burn from a receipt,
 * never send after a simulation that reverted, and never call an address other
 * than the deposit's own or the instance's.
 */

const INSTANCE = "0xC23f642716fDd5301E6F36e5007093A288581B9E" as Hex
const FORWARDER = "0xa199fdabb9f87d4a2aee095ca95cee3abf70f6ff"
const SUI = "0x7a1d4e3b9c5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f708"

const deposit = (over: Partial<DepositRow> = {}): DepositRow => ({
  id: "1",
  suiAddress: SUI,
  network: "mainnet",
  chain: "avalanche",
  forwarderAddress: FORWARDER,
  status: "cranking",
  waitingReason: null,
  lastBalance: 7_000_000n,
  lastBalanceAt: new Date(),
  hotUntil: new Date(Date.now() + 60_000),
  crankAttempts: 1,
  ...over,
})

function harness(args: {
  claim?: DepositRow | null
  hasCode?: boolean
  simulate?: { ok: boolean; message?: string }
  send?: Awaited<ReturnType<Signer["send"]>> | Error
  budget?: number
}) {
  const journal = {
    claimForCrank: vi.fn(async () =>
      args.claim === undefined ? deposit() : args.claim
    ),
    markWaiting: vi.fn(async () => {}),
    releaseCrank: vi.fn(async () => {}),
    recordBurn: vi.fn(async () => {
      throw new Error("the crank must never record a burn")
    }),
  } as unknown as Journal

  const rpc = {
    hasCode: vi.fn(async () => args.hasCode ?? false),
  } as unknown as EvmRpc

  const signer = {
    address: "0x" + "9".repeat(40),
    chain: "avalanche" as const,
    gasBalance: vi.fn(),
    simulate: vi.fn(async () => args.simulate ?? { ok: true }),
    send: vi.fn(async () => {
      if (args.send instanceof Error) throw args.send
      return (
        args.send ?? {
          status: "mined" as const,
          hash: "0xabc" as Hex,
          gasUsed: 150_000n,
        }
      )
    }),
  } as unknown as Signer

  return {
    journal,
    rpc,
    signer,
    run: () =>
      crankOnce(
        { journal, rpc, signer, instance: INSTANCE, budget: args.budget ?? 24 },
        "1"
      ),
  }
}

const callOf = (signer: Signer) =>
  (
    signer.simulate as unknown as {
      mock: { calls: Array<[{ to: Hex; data: Hex }]> }
    }
  ).mock.calls[0]?.[0]

describe("crankOnce", () => {
  it("does nothing when the deposit is not claimable", async () => {
    const h = harness({ claim: null })
    expect((await h.run()).kind).toBe("skipped")
    expect(h.rpc.hasCode).not.toHaveBeenCalled()
    expect(h.signer.simulate).not.toHaveBeenCalled()
  })

  it("deploys and burns in one call the first time", async () => {
    const h = harness({ hasCode: false })
    const outcome = await h.run()
    expect(outcome).toMatchObject({ kind: "submitted", deployed: false })
    const call = callOf(h.signer)
    // Through the instance, which is the only way to deploy the clone: a
    // direct call to an address without code succeeds and does nothing.
    expect(call?.to).toBe(INSTANCE)
    expect(call?.data.endsWith(SUI.slice(2))).toBe(true)
  })

  it("calls the deposit address directly once it has code", async () => {
    const h = harness({ hasCode: true })
    const outcome = await h.run()
    expect(outcome).toMatchObject({ kind: "submitted", deployed: true })
    const call = callOf(h.signer)
    expect(call?.to).toBe(FORWARDER)
    // forward(), so no argument at all: four bytes of selector.
    expect(call?.data.length).toBe(10)
  })

  it("uses a different selector for the two paths", async () => {
    const first = harness({ hasCode: false })
    await first.run()
    const later = harness({ hasCode: true })
    await later.run()
    expect(callOf(first.signer)?.data.slice(0, 10)).not.toBe(
      callOf(later.signer)?.data.slice(0, 10)
    )
  })

  it("never records a burn from the receipt", async () => {
    const h = harness({})
    await h.run()
    // Only a finalized DepositForBurn log counts; a receipt is a latest-block
    // observation and Polygon PoS can take it back.
    expect(h.journal.recordBurn).not.toHaveBeenCalled()
    expect(h.journal.markWaiting).not.toHaveBeenCalled()
  })

  describe("when Circle refuses", () => {
    it("waits without spending gas", async () => {
      const h = harness({
        simulate: {
          ok: false,
          message: "execution reverted: Pausable: paused",
        },
      })
      const outcome = await h.run()
      expect(outcome).toMatchObject({ kind: "waiting", alert: true })
      expect(h.signer.send).not.toHaveBeenCalled()
      expect(h.journal.markWaiting).toHaveBeenCalledWith(
        "1",
        "circle: transfers are paused"
      )
    })

    it("waits on the forwarder's own fee ceiling", async () => {
      const h = harness({
        simulate: { ok: false, message: "FeeAboveCeiling()" },
      })
      expect(await h.run()).toMatchObject({
        kind: "waiting",
        reason: "forwarder: Circle's minimum fee is above the 1% ceiling",
      })
    })

    it("handles a revert that only appears on chain", async () => {
      const h = harness({
        send: {
          status: "reverted",
          hash: "0xdead" as Hex,
          message: "execution reverted: Burn amount exceeds per tx limit",
        },
      })
      expect(await h.run()).toMatchObject({ kind: "waiting" })
      expect(h.journal.markWaiting).toHaveBeenCalled()
    })
  })

  describe("when the problem is ours", () => {
    it("releases the deposit for another attempt", async () => {
      const h = harness({
        simulate: {
          ok: false,
          message: "insufficient funds for gas * price + value",
        },
      })
      const outcome = await h.run()
      expect(outcome).toMatchObject({ kind: "released" })
      expect(h.journal.releaseCrank).toHaveBeenCalled()
      expect(h.journal.markWaiting).not.toHaveBeenCalled()
    })

    it("classifies a thrown send the same way", async () => {
      const h = harness({ send: new Error("nonce too low") })
      expect(await h.run()).toMatchObject({
        kind: "released",
        reason: "signer: nonce contention",
      })
    })
  })

  describe("the gas budget", () => {
    it("stops cranking an address that is being refilled forever", async () => {
      const h = harness({ claim: deposit({ crankAttempts: 25 }), budget: 24 })
      const outcome = await h.run()
      expect(outcome).toMatchObject({ kind: "waiting", alert: true })
      expect(h.signer.simulate).not.toHaveBeenCalled()
      expect(h.journal.markWaiting).toHaveBeenCalledWith(
        "1",
        "gas budget of 24 cranks exhausted for this address"
      )
    })

    it("allows the last attempt within budget", async () => {
      const h = harness({ claim: deposit({ crankAttempts: 24 }), budget: 24 })
      expect((await h.run()).kind).toBe("submitted")
    })
  })
})
