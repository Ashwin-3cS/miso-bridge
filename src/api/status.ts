import type { BurnRow, DepositRow } from "../journal.js"

/**
 * What a user should be told, derived from the journal's own states.
 *
 * Pure, so the whole table is testable without a database. The app renders
 * `phase`; `detail` is one sentence for a support screen. Internal statuses
 * stay internal: "waiting" means Circle refused the burn and the USDC is
 * still sitting at the address, which is not a failure and must not read
 * like one.
 */

export const phases = [
  "awaiting_deposit",
  "deposit_seen",
  "waiting_on_circle",
  "attesting",
  "delivering",
  "delivered",
  "needs_attention",
] as const

export type Phase = (typeof phases)[number]

const settled = new Set(["minted", "reconciled"])

export function publicPhase(args: {
  deposit: DepositRow
  burns: readonly BurnRow[]
}): { phase: Phase; detail: string } {
  const { deposit, burns } = args

  if (burns.some((burn) => burn.status === "quarantined"))
    return {
      phase: "needs_attention",
      detail:
        "A transfer from this address could not be verified and is being reviewed. " +
        "No funds have been lost.",
    }

  const unsettled = burns.filter((burn) => !settled.has(burn.status))
  const burn = unsettled[0]
  if (burn !== undefined) {
    if (burn.status === "discovered" || burn.status === "attesting")
      return {
        phase: "attesting",
        detail:
          "Your USDC has left the deposit address and Circle is signing the transfer.",
      }
    return {
      phase: "delivering",
      detail:
        "Circle has signed the transfer and it is being delivered to your Sui account.",
    }
  }

  if (deposit.status === "waiting")
    return {
      phase: "waiting_on_circle",
      detail:
        "Your USDC is at the deposit address and is waiting on Circle before it can " +
        "be forwarded. It stays where it is until then.",
    }

  if (deposit.status === "fundable" || deposit.status === "cranking")
    return {
      phase: "deposit_seen",
      detail: "Your deposit has arrived and is being forwarded.",
    }

  if (burns.length > 0)
    return {
      phase: "delivered",
      detail: "Delivered to your Sui account.",
    }

  return {
    phase: "awaiting_deposit",
    detail: "Waiting for USDC to arrive at the deposit address.",
  }
}
