/**
 * The state machines, as data.
 *
 * Workers are idempotent and crash-replayed, so "may this row move from here
 * to there" gets asked constantly. Keeping it as a pure table means it is
 * unit-testable without a database and reviewable without reading SQL, and it
 * mirrors the status check constraints in migrations/0001_init.sql.
 *
 * A move to the status a row already has is allowed and does nothing: that is
 * a worker running twice, which is normal, not an error.
 */

export const depositStatuses = [
  "issued",
  "fundable",
  "cranking",
  "cranked",
  "waiting",
] as const

export const burnStatuses = [
  "discovered",
  "attesting",
  "validated",
  "quarantined",
  "minting",
  "minted",
  "reconciled",
] as const

export const mintStatuses = ["submitting", "submitted", "confirmed"] as const

export type DepositStatus = (typeof depositStatuses)[number]
export type BurnStatus = (typeof burnStatuses)[number]
export type MintStatus = (typeof mintStatuses)[number]

export type Entity = "deposit" | "burn" | "mint"
export type StatusOf<E extends Entity> = E extends "deposit"
  ? DepositStatus
  : E extends "burn"
    ? BurnStatus
    : MintStatus

type Table<S extends string> = Readonly<Record<S, readonly S[]>>

/**
 * A deposit address is long-lived: it is issued once and can be funded,
 * cranked and funded again. `waiting` is a Circle condition (a pause, a zero
 * burn limit, a blacklist, a minimum fee above the 1% ceiling) that leaves the
 * USDC in place, so it always leads back to another attempt.
 */
const deposit: Table<DepositStatus> = {
  issued: ["fundable"],
  // Back to issued when the balance leaves without a burn of ours, which
  // happens when a third party cranks the address first.
  fundable: ["cranking", "issued"],
  cranking: ["cranked", "waiting", "fundable"],
  cranked: ["fundable"],
  waiting: ["cranking", "fundable"],
}

/**
 * A burn is settled history once reconciled or quarantined. `validated` can
 * go straight to `minted` without passing through `minting`: Sui may report
 * the nonce already used, because minting is permissionless and anyone may
 * have delivered it.
 */
const burn: Table<BurnStatus> = {
  discovered: ["attesting", "validated", "quarantined"],
  attesting: ["validated", "quarantined"],
  validated: ["minting", "minted"],
  // Back to validated after a failed or uncertain submission whose nonce
  // then reads unused; the message is never dropped.
  minting: ["minted", "validated"],
  minted: ["reconciled"],
  quarantined: [],
  reconciled: [],
}

const mint: Table<MintStatus> = {
  submitting: ["submitted", "confirmed"],
  submitted: ["confirmed", "submitting"],
  confirmed: [],
}

const tables = { deposit, burn, mint } as const

/** Statuses from which nothing may move. */
export const terminal: Readonly<Record<Entity, readonly string[]>> =
  Object.freeze({
    deposit: [],
    burn: ["quarantined", "reconciled"],
    mint: ["confirmed"],
  })

/**
 * The burn statuses that imply a validated, clean, attested message. Kept
 * here and asserted against the `attested_has_message` constraint, so the two
 * definitions cannot drift apart.
 */
export const validatedFamily: readonly BurnStatus[] = [
  "validated",
  "minting",
  "minted",
  "reconciled",
]

export function isAllowed<E extends Entity>(
  entity: E,
  from: StatusOf<E>,
  to: StatusOf<E>
): boolean {
  if (from === to) return true
  const next = (tables[entity] as Table<string>)[from]
  if (next === undefined) return false
  return next.includes(to)
}

/** Throws unless the move is allowed, naming what was legal instead. */
export function assertTransition<E extends Entity>(
  entity: E,
  from: StatusOf<E>,
  to: StatusOf<E>
): void {
  if (isAllowed(entity, from, to)) return
  const next = (tables[entity] as Table<string>)[from] ?? []
  const legal = next.length === 0 ? "nothing (terminal)" : next.join(", ")
  throw new Error(
    `${entity} cannot move ${from} -> ${to}; from ${from} it may move to ${legal}`
  )
}

/** Every reachable status, for exhaustiveness tests. */
export function statusesOf(entity: Entity): readonly string[] {
  return Object.keys(tables[entity])
}

/** Whether `to` is reachable from `from` in any number of steps. */
export function reachable(entity: Entity, from: string, to: string): boolean {
  const table = tables[entity] as Table<string>
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (current === to) return true
    for (const next of table[current] ?? [])
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
  }
  return false
}
