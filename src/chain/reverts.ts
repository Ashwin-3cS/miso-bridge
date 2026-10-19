/**
 * Classifying a failed crank.
 *
 * A crank that reverts is usually not a bug and not a loss: Circle refused
 * the burn and the USDC is still sitting at the deposit address, so the same
 * crank succeeds once the condition is lifted. The forwarder has no recovery
 * path, so the only correct response to such a revert is to wait and retry --
 * never to give up, and never to page as though funds were at risk.
 *
 * Pure, so the whole table is testable without a chain.
 */

export type CrankRevert = {
  /** Recorded as the deposit's waiting reason. */
  reason: string
  /**
   * True when the cause is Circle's or the token's policy: the funds are in
   * place and a later crank works. False when the cause is ours (gas, a bad
   * endpoint), which is a retry, not a wait.
   */
  wait: boolean
  /** True when this needs a human, not just patience. */
  alert: boolean
}

const table: ReadonlyArray<{
  match: RegExp
  reason: string
  wait: boolean
  alert?: boolean
}> = [
  // The forwarder's own guard: Circle's on-chain minimum fee exceeds 1% of the
  // balance. Deliberate, and it resolves when the fee falls or more is deposited.
  {
    match: /FeeAboveCeiling|0x8f4eb604/i,
    reason: "forwarder: Circle's minimum fee is above the 1% ceiling",
    wait: true,
  },
  {
    match: /burn amount exceeds per tx limit/i,
    reason: "circle: amount above the per-message burn limit",
    wait: true,
  },
  {
    match: /paused/i,
    reason: "circle: transfers are paused",
    wait: true,
    alert: true,
  },
  {
    match: /blacklist|Blacklistable/i,
    reason: "token: the address is blacklisted",
    wait: true,
    alert: true,
  },
  {
    match: /denylist|denied/i,
    reason: "circle: the address is on the deny list",
    wait: true,
    alert: true,
  },
  {
    match: /mint recipient must be nonzero/i,
    reason: "circle: the mint recipient is zero",
    wait: true,
    alert: true,
  },
  {
    match: /no (remote )?token\s*messenger|NoSuiRoute/i,
    reason: "circle: no route to Sui from this chain",
    wait: true,
    alert: true,
  },
  {
    match: /insufficient funds|gas required exceeds|max fee per gas/i,
    reason: "gas: the crank signer could not pay",
    wait: false,
    alert: true,
  },
  {
    match: /nonce too low|replacement transaction underpriced/i,
    reason: "signer: nonce contention",
    wait: false,
  },
  {
    match: /burn amount must be nonzero|amount must be nonzero/i,
    reason: "circle: nothing to burn",
    wait: true,
  },
]

export function classifyCrankRevert(message: string): CrankRevert {
  for (const entry of table)
    if (entry.match.test(message))
      return {
        reason: entry.reason,
        wait: entry.wait,
        alert: entry.alert ?? false,
      }
  // Unknown reverts wait rather than retry in a tight loop, and are alerted on
  // precisely because they are unclassified: the funds are still at the
  // address, so patience is safe and a surprise deserves a look.
  return {
    reason: `unclassified revert: ${message.slice(0, 200)}`,
    wait: true,
    alert: true,
  }
}
