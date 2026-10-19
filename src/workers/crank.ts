import type { Hex } from "viem"
import type { EvmRpc } from "../chain/evm.js"
import { classifyCrankRevert } from "../chain/reverts.js"
import {
  deployAndForwardData,
  forwardData,
  type Signer,
} from "../chain/signer.js"
import type { Journal } from "../journal.js"

/**
 * The crank: makes the call CCTP requires and an onramp cannot make.
 *
 * `depositForBurn` has to be called by whoever holds the USDC. The holder here
 * is a keyless clone whose recipient, destination domain, finality threshold
 * and fee ceiling are all fixed in its own bytecode, so this worker chooses
 * nothing: it picks the moment and pays the gas. Everything about where the
 * money goes was decided when the address was derived.
 *
 * A crank is never recorded as done from the receipt. The only evidence that
 * counts is a DepositForBurn log whose depositor is the deposit address, seen
 * at the finalized block -- which is the discovery worker's job. A receipt is
 * a latest-block observation and Polygon PoS can take it back.
 */

export type CrankDeps = {
  journal: Journal
  rpc: EvmRpc
  signer: Signer
  /** The forwarder instance: factory and clone implementation in one. */
  instance: Hex
  /** Cranks per address before it waits for a human. */
  budget: number
}

export type CrankOutcome =
  | { kind: "skipped"; why: string }
  | { kind: "waiting"; reason: string; alert: boolean }
  | { kind: "released"; reason: string }
  | { kind: "submitted"; hash: Hex; deployed: boolean; gasUsed: bigint }

export async function crankOnce(
  deps: CrankDeps,
  depositId: string
): Promise<CrankOutcome> {
  const { journal, rpc, signer, instance, budget } = deps

  const deposit = await journal.claimForCrank(depositId)
  if (deposit === null)
    return { kind: "skipped", why: "not fundable, or another worker holds it" }

  /**
   * A griefer can refill an address forever, and each crank costs us gas.
   * The budget bounds that; the funds are untouched and a human can lift it.
   */
  if (deposit.crankAttempts > budget) {
    const reason = `gas budget of ${budget} cranks exhausted for this address`
    await journal.markWaiting(deposit.id, reason)
    return { kind: "waiting", reason, alert: true }
  }

  // An address with no code has never been cranked, so the clone must be
  // deployed and burned in one transaction through the instance. A direct
  // call to an address without code succeeds and does nothing, so this order
  // matters.
  const deployed = await rpc.hasCode(deposit.forwarderAddress)
  const call = deployed
    ? { to: deposit.forwarderAddress as Hex, data: forwardData() }
    : { to: instance, data: deployAndForwardData(deposit.suiAddress as Hex) }

  const settle = async (message: string): Promise<CrankOutcome> => {
    const { reason, wait, alert } = classifyCrankRevert(message)
    if (wait) {
      await journal.markWaiting(deposit.id, reason)
      return { kind: "waiting", reason, alert }
    }
    await journal.releaseCrank(deposit.id, reason)
    return { kind: "released", reason }
  }

  // Simulate first: a Circle condition should cost no gas at all.
  const simulated = await signer.simulate(call)
  if (!simulated.ok) return settle(simulated.message ?? "simulation reverted")

  let sent
  try {
    sent = await signer.send(call)
  } catch (error) {
    return settle((error as Error).message)
  }
  if (sent.status === "reverted") return settle(sent.message)

  // Left in `cranking` on purpose. Discovery moves it to `cranked` when it
  // sees the finalized log, and the reconciler's deadline catches a crank that
  // never produced one.
  return {
    kind: "submitted",
    hash: sent.hash,
    deployed,
    gasUsed: sent.gasUsed,
  }
}
