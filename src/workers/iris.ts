import {
  decodeBurnMessage,
  fetchIrisMessages,
  forwarderBurnProblem,
} from "@misofm/cctp-forwarders/cctp-v2"
import type { EvmChain } from "@misofm/cctp-forwarders/evm-forwarder"
import type { BurnRow, Journal } from "../journal.js"

/**
 * The Iris poller: turns a discovered burn into an attested, validated message.
 *
 * Validation is the sibling repo's `forwarderBurnProblem`, which compares the
 * attested message byte for byte against the message that forwarder emits for
 * that amount and fee. It is not a trust decision -- Sui verifies Circle's
 * attestation itself, and a mint pays the recipient inside the signed message,
 * so nothing here can redirect funds. It is a bookkeeping decision: it binds a
 * message to a deposit, and refuses to bind one that does not belong.
 *
 * A transaction can carry CCTP traffic that is not ours. So a message that
 * fails validation is only quarantined when it claims to come from this
 * forwarder; anything else leaves the burn waiting, because the message we
 * want may simply not be signed yet.
 */

export type IrisDeps = {
  journal: Journal
  fetchFn: typeof fetch
  chain: EvmChain
  baseUrl?: string
  limit?: number
}

export type IrisOutcome =
  | { burnId: string; kind: "not-indexed" }
  | { burnId: string; kind: "pending"; delayReason: string | null }
  | { burnId: string; kind: "validated"; nonce: string }
  | { burnId: string; kind: "quarantined"; problem: string }

/** 32-byte left-padded form of an address, as it appears in a message. */
const padded = (address: string) =>
  "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0")

export async function irisOnce(deps: IrisDeps): Promise<IrisOutcome[]> {
  const { journal, chain } = deps
  const limit = deps.limit ?? 25

  const burns = [
    ...(await journal.burnsByStatus("discovered", limit)),
    ...(await journal.burnsByStatus("attesting", limit)),
  ].filter((burn) => burn.chain === chain)

  const outcomes: IrisOutcome[] = []
  for (const burn of burns) outcomes.push(await pollOne(deps, burn))
  return outcomes
}

async function pollOne(deps: IrisDeps, burn: BurnRow): Promise<IrisOutcome> {
  const { journal, fetchFn, chain, baseUrl } = deps

  const deposit = await journal.depositById(burn.depositId)
  if (deposit === null) throw new Error(`burn ${burn.id} has no deposit`)

  const messages = await fetchIrisMessages(
    fetchFn,
    { chain, transactionHash: burn.txHash },
    baseUrl
  )

  // 404: Iris has not indexed the transaction yet. Not an error, and not a
  // reason to stop: the reconciler's deadline is what notices a real stall.
  if (messages === null) {
    await journal.markAttesting(burn.id, null)
    return { burnId: burn.id, kind: "not-indexed" }
  }

  const complete = messages.filter(
    (message): message is Extract<typeof message, { status: "complete" }> =>
      message.status === "complete"
  )

  const expected = {
    chain,
    forwarder: deposit.forwarderAddress,
    recipient: deposit.suiAddress,
  }

  let claimedButWrong: string | null = null
  for (const message of complete) {
    const problem = forwarderBurnProblem(message.message, expected)
    if (problem === null) {
      const decoded = decodeBurnMessage(message.message)
      await journal.recordAttestation({
        burnId: burn.id,
        nonce: decoded.nonce,
        message: message.message,
        attestation: message.attestation,
        maxFee: decoded.maxFee,
        feeExecuted: decoded.feeExecuted,
      })
      return { burnId: burn.id, kind: "validated", nonce: decoded.nonce }
    }
    // Only a message that says it came from this forwarder is ours to reject.
    try {
      if (
        decodeBurnMessage(message.message).messageSender ===
        padded(deposit.forwarderAddress)
      )
        claimedButWrong ??= problem
    } catch {
      // Too short to decode: not a burn message, so not ours either.
    }
  }

  if (claimedButWrong !== null) {
    await journal.quarantineBurn(burn.id, claimedButWrong)
    return { burnId: burn.id, kind: "quarantined", problem: claimedButWrong }
  }

  await journal.markAttesting(burn.id, null)
  return { burnId: burn.id, kind: "pending", delayReason: null }
}
