import type { EvmChain } from "@misofm/cctp-forwarders/evm-forwarder"
import type { EvmRpc } from "../chain/evm.js"
import type { Journal } from "../journal.js"

/**
 * The watcher: notices that a deposit address has been funded.
 *
 * CCTP has no concept of "pay this address and it bridges" -- only a call made
 * by whoever holds the USDC -- and an onramp can only pay an address. So
 * nothing tells this service a deposit happened; it has to look. It polls the
 * balances of addresses worth watching (recently issued, flagged by a webhook,
 * or known non-zero) in one batched request, and records what it sees.
 *
 * It decides nothing about where funds go: recording a balance can only move a
 * deposit between issued and fundable. The crank worker acts on fundable, and
 * the forwarder itself chooses the recipient.
 *
 * Deliberately reads `latest`, not `finalized`. A crank on a reorged balance
 * simply replays -- the funds are either still there or already burned -- so
 * waiting for finality here would add minutes to every transfer for nothing.
 * Burn *accounting* is what must wait for finality, and that is the discovery
 * worker's job.
 */

export type WatcherDeps = {
  journal: Journal
  rpc: EvmRpc
  chain: EvmChain
  /** The chain's native USDC, from the forwarder build. */
  usdc: string
  /** Below this a crank costs more gas than it moves. */
  floor: bigint
  /** Addresses per pass; the rest are picked up on the next one. */
  limit?: number
}

export type WatchResult = {
  polled: number
  /** Deposits that just became fundable, for the crank worker. */
  fundable: string[]
  totalObserved: bigint
}

export async function watchOnce(deps: WatcherDeps): Promise<WatchResult> {
  const { journal, rpc, chain, usdc, floor } = deps
  const limit = deps.limit ?? 200

  const deposits = await journal.hotDeposits({ chain, limit })
  if (deposits.length === 0)
    return { polled: 0, fundable: [], totalObserved: 0n }

  const balances = await rpc.balancesOf({
    token: usdc,
    holders: deposits.map((deposit) => deposit.forwarderAddress),
  })
  if (balances.length !== deposits.length)
    throw new Error(
      `asked for ${deposits.length} balances, got ${balances.length}`
    )

  const fundable: string[] = []
  let totalObserved = 0n
  for (const [index, deposit] of deposits.entries()) {
    const balance = balances[index] as bigint
    totalObserved += balance
    const status = await journal.recordBalance({
      depositId: deposit.id,
      balance,
      floor,
    })
    if (status === "fundable") fundable.push(deposit.id)
  }

  return { polled: deposits.length, fundable, totalObserved }
}
