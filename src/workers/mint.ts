import type { Journal } from "../journal.js"
import type { SuiMinter } from "../chain/sui.js"

/**
 * The mint worker: delivers an attested message to Sui.
 *
 * Exactly-once rests on the nonce, not on this code being careful.
 * `receive_message` marks the nonce in the same atomic transaction that mints,
 * so the nonce is the delivery oracle: used means delivered, by whoever got
 * there first. Every branch below ends by consulting it rather than by
 * trusting what the worker thinks happened.
 *
 * Nothing here can lose a transfer. A validated message is never dropped: a
 * failure, an abort or an unknown outcome returns it to `validated` to be
 * retried, and because minting is permissionless a stuck worker only delays a
 * transfer that anyone else could also deliver.
 */

export type MintDeps = {
  journal: Journal
  sui: SuiMinter
  /** Messages per pass. */
  limit?: number
}

export type MintOutcome =
  | { burnId: string; kind: "skipped"; why: string }
  | { burnId: string; kind: "delivered"; nonce: string; by: string }
  | { burnId: string; kind: "minted"; nonce: string; digest: string }
  | { burnId: string; kind: "retry"; nonce: string; error: string }

export async function mintOnce(deps: MintDeps): Promise<MintOutcome[]> {
  const { journal } = deps
  const burns = await journal.burnsByStatus("validated", deps.limit ?? 10)
  const outcomes: MintOutcome[] = []
  for (const burn of burns) outcomes.push(await mintOne(deps, burn))
  return outcomes
}

async function mintOne(
  deps: MintDeps,
  burn: Awaited<ReturnType<Journal["burnsByStatus"]>>[number]
): Promise<MintOutcome> {
  const { journal, sui } = deps
  const { nonce, message, attestation } = burn

  // The schema will not let a burn reach `validated` without these, so their
  // absence is a bug rather than a state to handle gracefully.
  if (nonce === null || message === null || attestation === null)
    throw new Error(`burn ${burn.id} is validated but incomplete`)

  // Ask Sui before spending anything: someone else may have delivered it.
  if (await sui.nonceUsed(nonce)) {
    await journal.markDeliveredElsewhere(burn.id, nonce, "another caller")
    return { burnId: burn.id, kind: "delivered", nonce, by: "another caller" }
  }

  const mint = await journal.claimForMint(burn)
  if (mint === null)
    return {
      burnId: burn.id,
      kind: "skipped",
      why: "another worker holds the nonce, or it is already confirmed",
    }

  const release = async (error: string): Promise<MintOutcome> => {
    // Consult the oracle before deciding what the failure meant. An abort that
    // does not consume the nonce -- a deny-listed recipient, say -- leaves the
    // transfer deliverable, and it succeeds once the block is lifted.
    if (await sui.nonceUsed(nonce)) {
      await journal.markDeliveredElsewhere(
        burn.id,
        nonce,
        "an uncertain submission of ours"
      )
      return {
        burnId: burn.id,
        kind: "delivered",
        nonce,
        by: "an uncertain submission of ours",
      }
    }
    await journal.releaseMint({ nonce, burnId: burn.id, error })
    return { burnId: burn.id, kind: "retry", nonce, error }
  }

  const simulated = await sui.simulate({ message, attestation })
  if (!simulated.ok) return release(simulated.error ?? "simulation aborted")

  let submitted
  try {
    submitted = await sui.submit({ message, attestation })
  } catch (error) {
    return release(`submit failed: ${(error as Error).message}`)
  }
  if (submitted.status === "aborted")
    return release(`aborted on Sui: ${submitted.error}`)

  await journal.markMintSubmitted(nonce, submitted.digest)

  // Confirm from the nonce flag, not from our own receipt. The transfer is
  // delivered when Sui says the nonce is spent, and nothing else.
  if (!(await sui.nonceUsed(nonce)))
    return release(
      `Sui reported success in ${submitted.digest} but the nonce reads unused`
    )

  await journal.markMintConfirmed({
    nonce,
    burnId: burn.id,
    suiTxDigest: submitted.digest,
  })
  return { burnId: burn.id, kind: "minted", nonce, digest: submitted.digest }
}
