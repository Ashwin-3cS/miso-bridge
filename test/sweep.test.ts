import { describe, expect, it, vi } from "vitest"
import type { EvmRpc } from "../src/chain/evm.js"
import type { DepositRow, Journal } from "../src/journal.js"
import { sweepOnce } from "../src/workers/sweep.js"

/**
 * The sweep exists because the forwarder has no recovery path: USDC that
 * arrives at an address the hot set has forgotten still has to be noticed.
 * These tests pin that it records what it finds, rather than only reporting
 * it, and that it pages through and comes back around.
 */

const USDC = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"

const deposit = (id: string): DepositRow => ({
  id,
  suiAddress: "0x" + id.padStart(64, "0"),
  network: "mainnet",
  chain: "avalanche",
  forwarderAddress: "0x" + id.padStart(40, "0"),
  status: "issued",
  waitingReason: null,
  lastBalance: 0n,
  lastBalanceAt: null,
  hotUntil: null,
  crankAttempts: 0,
  ...{},
})

function harness(args: { pages: DepositRow[][]; balances: bigint[][] }) {
  let call = 0
  const recorded: Array<{ depositId: string; balance: bigint }> = []
  const journal = {
    allDeposits: vi.fn(async () => args.pages[call] ?? []),
    recordBalance: vi.fn(
      async ({
        depositId,
        balance,
      }: {
        depositId: string
        balance: bigint
      }) => {
        recorded.push({ depositId, balance })
        return "issued" as const
      }
    ),
  } as unknown as Journal
  const rpc = {
    balancesOf: vi.fn(async () => {
      const page = args.balances[call] ?? []
      call += 1
      return page
    }),
  } as unknown as EvmRpc
  return { journal, rpc, recorded }
}

describe("sweepOnce", () => {
  const run = (h: ReturnType<typeof harness>, afterId = "0", pageSize = 2) =>
    sweepOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
      usdc: USDC,
      floor: 1_000_000n,
      afterId,
      pageSize,
    })

  it("records every balance it reads, not only the funded ones", async () => {
    const h = harness({
      pages: [[deposit("1"), deposit("2")]],
      balances: [[0n, 5_000_000n]],
    })
    const result = await run(h)
    expect(h.recorded).toEqual([
      { depositId: "1", balance: 0n },
      { depositId: "2", balance: 5_000_000n },
    ])
    expect(result.funded).toEqual([
      {
        depositId: "2",
        address: "0x" + "2".padStart(40, "0"),
        balance: 5_000_000n,
      },
    ])
  })

  it("reports dust, which is below the crank floor but still someone's money", async () => {
    const h = harness({
      pages: [[deposit("1"), deposit("2")]],
      balances: [[1n, 0n]],
    })
    expect((await run(h)).funded.map((f) => f.balance)).toEqual([1n])
  })

  it("carries its position to the next page", async () => {
    const h = harness({
      pages: [[deposit("1"), deposit("2")]],
      balances: [[0n, 0n]],
    })
    expect((await run(h)).nextAfterId).toBe("2")
  })

  it("wraps around when a page comes back short", async () => {
    const h = harness({ pages: [[deposit("9")]], balances: [[0n]] })
    const result = await run(h)
    expect(result.nextAfterId).toBe("0")
    expect(result.checked).toBe(1)
  })

  it("does nothing, and calls nothing, when there are no deposits", async () => {
    const h = harness({ pages: [[]], balances: [[]] })
    expect(await run(h)).toEqual({ checked: 0, nextAfterId: "0", funded: [] })
    expect(h.rpc.balancesOf).not.toHaveBeenCalled()
  })

  it("refuses a reply that does not line up with the request", async () => {
    const h = harness({
      pages: [[deposit("1"), deposit("2")]],
      balances: [[1n]],
    })
    await expect(run(h)).rejects.toThrow("asked for 2 balances, got 1")
    expect(h.recorded).toEqual([])
  })
})
