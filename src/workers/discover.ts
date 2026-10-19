import { findForwarderBurns } from "@misofm/cctp-forwarders/cctp-v2"
import type { EvmChain } from "@misofm/cctp-forwarders/evm-forwarder"
import type { EvmRpc } from "../chain/evm.js"
import type { Journal } from "../journal.js"

/**
 * Discovery: the only thing that may declare a crank done.
 *
 * A receipt is not evidence. Polygon PoS can reorg a seen DepositForBurn away,
 * and minting against a burn that no longer exists would mint nothing and
 * corrupt the journal, so burns are only ever taken from the finalized block.
 * This is the deliberate asymmetry with the watcher, which reads latest
 * because a crank on a reorged balance merely replays.
 *
 * It also recovers burns this service did not cause. Cranking is
 * permissionless, so a third party or a manual crank produces a burn we still
 * have to attest and mint; nothing here cares who paid the gas.
 *
 * Scanning is windowed because providers cap `eth_getLogs` ranges -- the
 * public Avalanche endpoint at 100 blocks -- and the cursor advances after
 * each window, so catching up after an outage resumes where it stopped
 * instead of restarting the whole range.
 */

export type DiscoverDeps = {
  journal: Journal
  rpc: EvmRpc
  chain: EvmChain
  /** First scan starts this far back, before any cursor exists. */
  initialLookback?: bigint
  /** Blocks per eth_getLogs call; keep at or below the provider's cap. */
  windowBlocks?: bigint
  /** Windows per pass, so one tick cannot run for an unbounded time. */
  maxWindows?: number
  /** Deposits examined per pass. */
  limit?: number
}

export type DiscoverResult = {
  from: bigint
  /** The block the cursor now sits at: everything up to here has been scanned. */
  to: bigint
  scanned: number
  found: number
  windows: number
  /** True when the pass stopped at its window budget, not at finality. */
  behind: boolean
}

export async function discoverOnce(
  deps: DiscoverDeps
): Promise<DiscoverResult> {
  const { journal, rpc, chain } = deps
  const limit = deps.limit ?? 100
  const initialLookback = deps.initialLookback ?? 10_000n
  const windowBlocks = deps.windowBlocks ?? 100n
  const maxWindows = deps.maxWindows ?? 20

  // Read the finalized height once and scan to exactly that block rather than
  // passing the "finalized" tag through: the tag moves between calls, so the
  // cursor would claim a range that was never scanned.
  const finalized = await rpc.finalizedBlockNumber()
  const cursor = await journal.cursor("discover", chain)
  const from =
    cursor ?? (finalized > initialLookback ? finalized - initialLookback : 0n)

  const deposits = await journal.depositsAwaitingDiscovery({ chain, limit })

  /**
   * With nothing to scan there is nothing to find, and the cursor can go
   * straight to finality. A deposit that starts cranking later does so at the
   * latest block, which is above this one, so no burn can hide below the
   * cursor.
   */
  if (deposits.length === 0) {
    const to = finalized > from ? finalized : from
    await journal.advanceCursor({ name: "discover", chain, block: to })
    return { from, to, scanned: 0, found: 0, windows: 0, behind: false }
  }

  let scannedTo = from
  let found = 0
  let windows = 0
  // Inclusive of the finalized block itself. With `<` the last block was left
  // for the next pass, which lost nothing but made the cursor lag a block
  // behind finality and report itself permanently behind.
  while (scannedTo <= finalized && windows < maxWindows) {
    const windowFrom = scannedTo
    // An inclusive span of exactly windowBlocks blocks. A provider that caps
    // at 100 rejects fromBlock..fromBlock+100, which is 101 blocks, so the
    // obvious arithmetic is off by one in the direction that fails.
    const windowEnd = windowFrom + windowBlocks - 1n
    const windowTo = windowEnd > finalized ? finalized : windowEnd
    for (const deposit of deposits) {
      const burns = await findForwarderBurns(rpc, {
        chain,
        forwarder: deposit.forwarderAddress,
        fromBlock: windowFrom,
        toBlock: windowTo,
      })
      // The reviewed discovery call filters by token and depositor and returns
      // logs in getLogs order, so a burn's position within one transaction is
      // stable across rescans. That is what makes rediscovery idempotent.
      const perTransaction = new Map<string, number>()
      for (const burn of burns) {
        const index = perTransaction.get(burn.transactionHash) ?? 0
        perTransaction.set(burn.transactionHash, index + 1)
        const { isNew } = await journal.recordBurn({
          depositId: deposit.id,
          chain,
          txHash: burn.transactionHash,
          burnIndex: index,
          blockNumber: burn.blockNumber,
          amount: burn.amount,
        })
        if (isNew) found += 1
      }
    }
    // Advance past the window just scanned, so windows are contiguous and no
    // block is requested twice. recordBurn is idempotent regardless, which is
    // what makes resuming after a crash safe.
    scannedTo = windowTo + 1n
    windows += 1
    await journal.advanceCursor({ name: "discover", chain, block: windowTo })
  }

  return {
    from,
    to: scannedTo > from ? scannedTo - 1n : from,
    scanned: deposits.length,
    found,
    windows,
    behind: scannedTo <= finalized,
  }
}
