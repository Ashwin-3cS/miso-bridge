import { describe, expect, it, vi } from "vitest"
import type { EvmRpc } from "../src/chain/evm.js"
import type { DepositRow, Journal } from "../src/journal.js"
import { watchOnce } from "../src/workers/watcher.js"

/**
 * The watcher with an injected journal and RPC. The property that matters is
 * that balance N belongs to deposit N: a misalignment would record someone
 * else's deposit against a recipient.
 */

const USDC = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"

const deposit = (id: string, address: string): DepositRow => ({
  id,
  suiAddress: "0x" + id.padStart(64, "0"),
  network: "mainnet",
  chain: "avalanche",
  forwarderAddress: address,
  status: "issued",
  waitingReason: null,
  lastBalance: 0n,
  lastBalanceAt: null,
  hotUntil: new Date(Date.now() + 60_000),
  crankAttempts: 0,
})

function harness(args: {
  deposits: DepositRow[]
  balances: bigint[]
  floor?: bigint
}) {
  const recorded: Array<{ depositId: string; balance: bigint }> = []
  const journal = {
    hotDeposits: vi.fn(async () => args.deposits),
    recordBalance: vi.fn(
      async ({
        depositId,
        balance,
        floor,
      }: {
        depositId: string
        balance: bigint
        floor: bigint
      }) => {
        recorded.push({ depositId, balance })
        return balance >= floor ? ("fundable" as const) : ("issued" as const)
      }
    ),
  } as unknown as Journal

  const rpc = {
    chain: "avalanche" as const,
    balancesOf: vi.fn(async () => args.balances),
    hasCode: vi.fn(),
    finalizedBlockNumber: vi.fn(),
    assertChain: vi.fn(),
    request: vi.fn(),
  } as unknown as EvmRpc

  return {
    journal,
    rpc,
    recorded,
    run: () =>
      watchOnce({
        journal,
        rpc,
        chain: "avalanche",
        usdc: USDC,
        floor: args.floor ?? 1_000_000n,
      }),
  }
}

describe("watchOnce", () => {
  it("does not call out when nothing is worth watching", async () => {
    const h = harness({ deposits: [], balances: [] })
    expect(await h.run()).toEqual({
      polled: 0,
      fundable: [],
      totalObserved: 0n,
    })
    expect(h.rpc.balancesOf).not.toHaveBeenCalled()
  })

  it("records each balance against its own deposit", async () => {
    const h = harness({
      deposits: [
        deposit("1", "0x" + "a".repeat(40)),
        deposit("2", "0x" + "b".repeat(40)),
        deposit("3", "0x" + "c".repeat(40)),
      ],
      balances: [5_000_000n, 0n, 2_000_000n],
    })
    const result = await h.run()
    expect(h.recorded).toEqual([
      { depositId: "1", balance: 5_000_000n },
      { depositId: "2", balance: 0n },
      { depositId: "3", balance: 2_000_000n },
    ])
    expect(result.fundable).toEqual(["1", "3"])
    expect(result.polled).toBe(3)
    expect(result.totalObserved).toBe(7_000_000n)
  })

  it("asks for the balances of exactly the hot addresses", async () => {
    const h = harness({
      deposits: [deposit("1", "0x" + "a".repeat(40))],
      balances: [1n],
    })
    await h.run()
    expect(h.rpc.balancesOf).toHaveBeenCalledWith({
      token: USDC,
      holders: ["0x" + "a".repeat(40)],
    })
  })

  it("leaves a dust balance alone", async () => {
    const h = harness({
      deposits: [deposit("1", "0x" + "a".repeat(40))],
      balances: [999_999n],
      floor: 1_000_000n,
    })
    expect((await h.run()).fundable).toEqual([])
  })

  it("refuses a reply that does not line up with the request", async () => {
    const h = harness({
      deposits: [
        deposit("1", "0x" + "a".repeat(40)),
        deposit("2", "0x" + "b".repeat(40)),
      ],
      balances: [1n],
    })
    await expect(h.run()).rejects.toThrow("asked for 2 balances, got 1")
    expect(h.recorded).toEqual([])
  })

  it("reads latest, not finalized", async () => {
    const h = harness({
      deposits: [deposit("1", "0x" + "a".repeat(40))],
      balances: [5_000_000n],
    })
    await h.run()
    // A crank on a reorged balance replays harmlessly; waiting for finality
    // here would add minutes to every transfer for nothing.
    expect(h.rpc.finalizedBlockNumber).not.toHaveBeenCalled()
  })
})
