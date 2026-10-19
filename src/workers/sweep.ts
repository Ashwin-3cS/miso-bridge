import type { EvmChain } from "@misofm/cctp-forwarders/evm-forwarder"
import type { EvmRpc } from "../chain/evm.js"
import type { Journal } from "../journal.js"

/**
 * The slow sweep over every address ever issued.
 *
 * The watcher's hot set deliberately forgets addresses: polling every address
 * forever does not scale, and almost all of them are empty forever. But the
 * forwarder has no recovery path, so USDC that arrives at a forgotten address
 * -- a user reusing one months later, an onramp retrying an old quote -- must
 * still be noticed and forwarded. Launch gate 6 asks for exactly this: an
 * alert on any balance at any address ever issued.
 *
 * It pages through deposits by id and returns where it stopped, so the caller
 * can carry the position across ticks and come back around.
 */

export type SweepDeps = {
  journal: Journal
  rpc: EvmRpc
  chain: EvmChain
  usdc: string
  floor: bigint
  /** Where the last page stopped; "0" starts from the beginning. */
  afterId?: string
  pageSize?: number
}

export type SweepResult = {
  checked: number
  /** The id to pass as afterId next time; "0" when the sweep wrapped around. */
  nextAfterId: string
  /** Addresses holding USDC, whatever their status. */
  funded: Array<{ depositId: string; address: string; balance: bigint }>
}

export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const { journal, rpc, chain, usdc, floor } = deps
  const pageSize = deps.pageSize ?? 200
  const afterId = deps.afterId ?? "0"

  const deposits = await journal.allDeposits({
    chain,
    afterId,
    limit: pageSize,
  })
  if (deposits.length === 0) return { checked: 0, nextAfterId: "0", funded: [] }

  const balances = await rpc.balancesOf({
    token: usdc,
    holders: deposits.map((deposit) => deposit.forwarderAddress),
  })
  if (balances.length !== deposits.length)
    throw new Error(
      `asked for ${deposits.length} balances, got ${balances.length}`
    )

  const funded: SweepResult["funded"] = []
  for (const [index, deposit] of deposits.entries()) {
    const balance = balances[index] as bigint
    // Recording it is what makes the sweep useful rather than merely
    // informative: a balance at or above the floor moves the deposit to
    // fundable, and the crank picks it up like any other.
    await journal.recordBalance({ depositId: deposit.id, balance, floor })
    if (balance > 0n)
      funded.push({
        depositId: deposit.id,
        address: deposit.forwarderAddress,
        balance,
      })
  }

  const last = deposits[deposits.length - 1]
  return {
    checked: deposits.length,
    // A short page means the end; start over next time.
    nextAfterId: deposits.length < pageSize ? "0" : (last?.id ?? "0"),
    funded,
  }
}
