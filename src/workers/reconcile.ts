import type { EvmChain } from "@misofm/cctp-forwarders/evm-forwarder"
import type { Signer } from "../chain/signer.js"
import type { SuiMinter } from "../chain/sui.js"
import type { Journal } from "../journal.js"
import type { AlertSink } from "../observability.js"
import { formatUsdc } from "../usdc.js"

/**
 * The reconciler: notices what the other workers cannot.
 *
 * Every other worker acts on a row and moves on. Nothing in them can see that
 * a row stopped moving, which is the failure that matters here, because the
 * forwarder has no recovery path and a transfer that silently stops is the
 * worst outcome available. So this worker only looks and alerts; it changes no
 * state and spends nothing.
 *
 * Deadlines are per stage rather than end to end, so an alert says which leg
 * is stuck: a crank that produced no finalized burn, a burn Circle has not
 * attested, or a validated message that has not been minted.
 */

export type ReconcileDeps = {
  journal: Journal
  alerts: AlertSink
  deadlines: {
    /** Cranked but no finalized DepositForBurn. */
    crankSeconds: number
    /** Discovered but not attested by Circle. */
    attestSeconds: number
    /** Validated but not minted. */
    mintSeconds: number
    /** Waiting on a Circle condition; expected, but not forever. */
    waitingSeconds: number
  }
  gas?: {
    signers?: ReadonlyArray<{ chain: EvmChain; signer: Signer }>
    sui?: SuiMinter
    /** Native-token floors, in wei and in MIST. */
    evmFloor: bigint
    suiFloor: bigint
  }
  limit?: number
}

export type ReconcileReport = {
  stalledCranks: number
  unattested: number
  unminted: number
  waiting: number
  quarantined: number
  lowGas: string[]
  openAlerts: number
}

export async function reconcileOnce(
  deps: ReconcileDeps
): Promise<ReconcileReport> {
  const { journal, alerts, deadlines } = deps
  const limit = deps.limit ?? 100

  const stalledCranks = await journal.stalledDeposits({
    status: "cranking",
    olderThanSeconds: deadlines.crankSeconds,
    limit,
  })
  for (const deposit of stalledCranks)
    await alerts.raise({
      kind: "crank-produced-no-burn",
      subject: `deposit:${deposit.id}`,
      severity: "page",
      payload: {
        chain: deposit.chain,
        address: deposit.forwarderAddress,
        attempts: deposit.crankAttempts,
        balance: formatUsdc(deposit.lastBalance),
      },
    })

  const waiting = await journal.stalledDeposits({
    status: "waiting",
    olderThanSeconds: deadlines.waitingSeconds,
    limit,
  })
  for (const deposit of waiting)
    await alerts.raise({
      kind: "waiting-on-circle",
      subject: `deposit:${deposit.id}`,
      // Expected, and the funds are in place: a notice, not a page. It is
      // recorded so that it can be seen to have cleared.
      severity: "notice",
      payload: {
        chain: deposit.chain,
        reason: deposit.waitingReason,
        balance: formatUsdc(deposit.lastBalance),
      },
    })

  const unattested = await journal.stalledBurns({
    statuses: ["discovered", "attesting"],
    olderThanSeconds: deadlines.attestSeconds,
    limit,
  })
  for (const burn of unattested)
    await alerts.raise({
      kind: "burn-not-attested",
      subject: `burn:${burn.id}`,
      severity: "page",
      payload: {
        chain: burn.chain,
        txHash: burn.txHash,
        amount: formatUsdc(burn.amount),
        delayReason: burn.delayReason,
      },
    })

  const unminted = await journal.stalledBurns({
    statuses: ["validated", "minting"],
    olderThanSeconds: deadlines.mintSeconds,
    limit,
  })
  for (const burn of unminted)
    await alerts.raise({
      kind: "attested-but-not-minted",
      subject: `burn:${burn.id}`,
      severity: "page",
      payload: {
        chain: burn.chain,
        nonce: burn.nonce,
        amount: formatUsdc(burn.amount),
      },
    })

  // No deadline: a quarantined burn is a message that claimed to be this
  // forwarder's and was not. It needs a human whenever it appears.
  const quarantined = await journal.burnsByStatus("quarantined", limit)
  for (const burn of quarantined)
    await alerts.raise({
      kind: "burn-quarantined",
      subject: `burn:${burn.id}`,
      severity: "page",
      payload: {
        chain: burn.chain,
        txHash: burn.txHash,
        problem: burn.problem,
      },
    })

  const lowGas: string[] = []
  if (deps.gas !== undefined) {
    for (const { chain, signer } of deps.gas.signers ?? []) {
      const balance = await signer.gasBalance()
      const subject = `gas:${chain}`
      if (balance < deps.gas.evmFloor) {
        lowGas.push(subject)
        await alerts.raise({
          kind: "crank-gas-low",
          subject,
          severity: "page",
          payload: { address: signer.address, balance: balance.toString() },
        })
      } else await alerts.resolve("crank-gas-low", subject)
    }
    if (deps.gas.sui !== undefined) {
      const balance = await deps.gas.sui.gasBalance()
      if (balance < deps.gas.suiFloor) {
        lowGas.push("gas:sui")
        await alerts.raise({
          kind: "mint-gas-low",
          subject: "gas:sui",
          severity: "page",
          payload: {
            address: deps.gas.sui.address,
            balance: balance.toString(),
          },
        })
      } else await alerts.resolve("mint-gas-low", "gas:sui")
    }
  }

  return {
    stalledCranks: stalledCranks.length,
    unattested: unattested.length,
    unminted: unminted.length,
    waiting: waiting.length,
    quarantined: quarantined.length,
    lowGas,
    openAlerts: await alerts.openCount(),
  }
}
