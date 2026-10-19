import { describe, expect, it, vi } from "vitest"
import type { EvmRpc } from "../src/chain/evm.js"
import type { DepositRow, Journal } from "../src/journal.js"
import { discoverOnce } from "../src/workers/discover.js"

/**
 * Discovery with a scripted chain. The properties under test are the ones the
 * fork rehearsal proved once and must keep: windows never exceed the
 * provider's cap, the cursor records exactly what was scanned, and nothing is
 * taken from above the finalized block.
 */

const MESSENGER = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"
const USDC = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"
const FORWARDER = "0xa199fdabb9f87d4a2aee095ca95cee3abf70f6ff"
const TOPIC0 =
  "0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5"

const bytes32 = (address: string) =>
  "0x" + address.replace(/^0x/, "").padStart(64, "0")

const deposit: DepositRow = {
  id: "1",
  suiAddress: "0x" + "7".repeat(64),
  network: "mainnet",
  chain: "avalanche",
  forwarderAddress: FORWARDER,
  status: "cranking",
  waitingReason: null,
  lastBalance: 0n,
  lastBalanceAt: null,
  hotUntil: null,
  crankAttempts: 1,
}

/** A DepositForBurn log the reviewed discovery call will accept. */
const burnLog = (block: bigint, txHash: string, amount: bigint) => ({
  address: MESSENGER,
  topics: [TOPIC0, bytes32(USDC), bytes32(FORWARDER)],
  data: "0x" + amount.toString(16).padStart(64, "0") + "00".repeat(32),
  blockNumber: "0x" + block.toString(16),
  transactionHash: txHash,
  removed: false,
})

function harness(args: {
  finalized: bigint
  cursor?: bigint | null
  deposits?: DepositRow[]
  logsIn?: (from: bigint, to: bigint) => unknown[]
}) {
  const ranges: Array<{ from: bigint; to: bigint }> = []
  const cursors: bigint[] = []
  const recorded: Array<{ txHash: string; burnIndex: number; amount: bigint }> =
    []
  let cursor = args.cursor ?? null

  const journal = {
    cursor: vi.fn(async () => cursor),
    advanceCursor: vi.fn(async ({ block }: { block: bigint }) => {
      cursors.push(block)
      cursor = cursor === null || block > cursor ? block : cursor
      return cursor
    }),
    depositsAwaitingDiscovery: vi.fn(async () => args.deposits ?? [deposit]),
    recordBurn: vi.fn(
      async (burn: { txHash: string; burnIndex: number; amount: bigint }) => {
        const seen = recorded.some(
          (r) => r.txHash === burn.txHash && r.burnIndex === burn.burnIndex
        )
        if (!seen) recorded.push(burn)
        return { burn: {} as never, isNew: !seen }
      }
    ),
  } as unknown as Journal

  const rpc = {
    chain: "avalanche" as const,
    finalizedBlockNumber: vi.fn(async () => args.finalized),
    request: vi.fn(
      async ({ method, params }: { method: string; params: unknown[] }) => {
        if (method === "eth_chainId") return "0xa86a"
        if (method === "eth_getLogs") {
          const [filter] = params as [{ fromBlock: string; toBlock: string }]
          const from = BigInt(filter.fromBlock)
          const to = BigInt(filter.toBlock)
          ranges.push({ from, to })
          return args.logsIn?.(from, to) ?? []
        }
        throw new Error(`unexpected ${method}`)
      }
    ),
  } as unknown as EvmRpc

  return { journal, rpc, ranges, cursors, recorded }
}

describe("discoverOnce", () => {
  it("never requests more blocks than the window allows", async () => {
    const h = harness({ finalized: 1_000n, cursor: 500n })
    await discoverOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
      windowBlocks: 100n,
      maxWindows: 20,
    })
    for (const { from, to } of h.ranges)
      expect(to - from + 1n).toBeLessThanOrEqual(100n)
  })

  it("covers the whole range with contiguous windows", async () => {
    const h = harness({ finalized: 1_000n, cursor: 500n })
    await discoverOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
      windowBlocks: 100n,
    })
    expect(h.ranges[0]).toEqual({ from: 500n, to: 599n })
    expect(h.ranges[1]).toEqual({ from: 600n, to: 699n })
    expect(h.ranges[h.ranges.length - 1]?.to).toBe(1_000n)
    // No gaps and no repeats.
    for (let i = 1; i < h.ranges.length; i += 1)
      expect(h.ranges[i]?.from).toBe((h.ranges[i - 1]?.to ?? 0n) + 1n)
  })

  it("stops at its window budget and says it is behind", async () => {
    const h = harness({ finalized: 100_000n, cursor: 0n })
    const result = await discoverOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
      windowBlocks: 100n,
      maxWindows: 3,
    })
    expect(h.ranges.length).toBe(3)
    expect(result.behind).toBe(true)
    expect(result.to).toBe(299n)
  })

  it("advances the cursor per window, so an outage resumes mid-catch-up", async () => {
    const h = harness({ finalized: 1_000n, cursor: 700n })
    await discoverOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
      windowBlocks: 100n,
    })
    expect(h.cursors).toEqual([799n, 899n, 999n, 1_000n])
  })

  it("starts a first scan at the lookback, not at genesis", async () => {
    const h = harness({ finalized: 5_000n, cursor: null })
    await discoverOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
      initialLookback: 200n,
      windowBlocks: 100n,
    })
    expect(h.ranges[0]?.from).toBe(4_800n)
  })

  it("records each burn once, keyed by its position in the transaction", async () => {
    const tx = "0x" + "a".repeat(64)
    const h = harness({
      finalized: 600n,
      cursor: 500n,
      logsIn: (from) =>
        from === 500n
          ? [burnLog(550n, tx, 7_000_000n), burnLog(550n, tx, 3_000_000n)]
          : [],
    })
    const result = await discoverOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
      windowBlocks: 100n,
    })
    expect(result.found).toBe(2)
    expect(h.recorded.map((r) => r.burnIndex)).toEqual([0, 1])
    expect(h.recorded.map((r) => r.amount)).toEqual([7_000_000n, 3_000_000n])
  })

  it("reports nothing new when the same burn comes back", async () => {
    const tx = "0x" + "b".repeat(64)
    const h = harness({
      finalized: 600n,
      cursor: 500n,
      logsIn: () => [burnLog(550n, tx, 1_000_000n)],
    })
    const options = {
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche" as const,
      windowBlocks: 100n,
    }
    expect((await discoverOnce(options)).found).toBe(1)
    // The cursor has moved on, so re-scan from where it was.
    h.ranges.length = 0
    expect((await discoverOnce({ ...options })).found).toBe(0)
  })

  it("scans nothing above the finalized block", async () => {
    const h = harness({ finalized: 1_000n, cursor: 950n })
    await discoverOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
      windowBlocks: 100n,
    })
    for (const { to } of h.ranges) expect(to).toBeLessThanOrEqual(1_000n)
  })

  it("does no work at all when nothing is awaiting discovery", async () => {
    const h = harness({ finalized: 1_000n, cursor: 500n, deposits: [] })
    const result = await discoverOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
    })
    expect(h.ranges).toEqual([])
    expect(result).toMatchObject({
      scanned: 0,
      found: 0,
      windows: 0,
      to: 1_000n,
    })
    // The cursor still advances: a deposit that starts cranking later does so
    // above this block, so no burn can hide below it.
    expect(h.cursors).toEqual([1_000n])
  })

  it("does nothing when the cursor is already past finality", async () => {
    const h = harness({ finalized: 500n, cursor: 900n, deposits: [] })
    const result = await discoverOnce({
      journal: h.journal,
      rpc: h.rpc,
      chain: "avalanche",
    })
    expect(result.to).toBe(900n)
    expect(h.ranges).toEqual([])
  })
})
