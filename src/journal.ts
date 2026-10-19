import type { EvmChain } from "@misofm/cctp-forwarders/evm-forwarder"
import type { Network } from "./config.js"
import { big, NOT_ACQUIRED, type Db, type Queryable } from "./db.js"
import {
  assertTransition,
  type BurnStatus,
  type DepositStatus,
  type Entity,
  type MintStatus,
} from "./transitions.js"

/**
 * The journal: the only module that writes state transitions.
 *
 * Every move reads the current status `for update`, checks it against
 * src/transitions.ts, writes the new status, and records a row in
 * `transitions` with the evidence that caused it — all in one transaction. A
 * worker that crashes between two of those steps has done none of them.
 *
 * Nothing here can move USDC. The journal records what Circle and Sui already
 * did; it chooses no recipient and signs nothing.
 */

export type DepositRow = {
  id: string
  suiAddress: string
  network: Network
  chain: EvmChain
  forwarderAddress: string
  status: DepositStatus
  waitingReason: string | null
  lastBalance: bigint
  lastBalanceAt: Date | null
  hotUntil: Date | null
  crankAttempts: number
}

export type BurnRow = {
  id: string
  depositId: string
  network: Network
  chain: EvmChain
  txHash: string
  burnIndex: number
  blockNumber: bigint
  amount: bigint
  status: BurnStatus
  nonce: string | null
  message: Uint8Array | null
  attestation: Uint8Array | null
  maxFee: bigint | null
  feeExecuted: bigint | null
  problem: string | null
  delayReason: string | null
}

export type MintRow = {
  nonce: string
  burnId: string
  status: MintStatus
  suiTxDigest: string | null
  attempts: number
  lastError: string | null
}

/** Evidence recorded with a transition. Must be JSON-safe: no bigints. */
export type Evidence = Record<string, string | number | boolean | null>

type Row = Record<string, unknown>

const depositRow = (row: Row): DepositRow => ({
  id: String(row.id),
  suiAddress: String(row.sui_address),
  network: row.network as Network,
  chain: row.chain as EvmChain,
  forwarderAddress: String(row.forwarder_address),
  status: row.status as DepositStatus,
  waitingReason: (row.waiting_reason as string | null) ?? null,
  lastBalance: big(row.last_balance as string),
  lastBalanceAt: (row.last_balance_at as Date | null) ?? null,
  hotUntil: (row.hot_until as Date | null) ?? null,
  crankAttempts: Number(row.crank_attempts),
})

const burnRow = (row: Row): BurnRow => ({
  id: String(row.id),
  depositId: String(row.deposit_id),
  network: row.network as Network,
  chain: row.chain as EvmChain,
  txHash: String(row.tx_hash),
  burnIndex: Number(row.burn_index),
  blockNumber: big(row.block_number as string),
  amount: big(row.amount as string),
  status: row.status as BurnStatus,
  nonce: (row.nonce as string | null) ?? null,
  message: (row.message as Uint8Array | null) ?? null,
  attestation: (row.attestation as Uint8Array | null) ?? null,
  maxFee: row.max_fee === null ? null : big(row.max_fee as string),
  feeExecuted:
    row.fee_executed === null ? null : big(row.fee_executed as string),
  problem: (row.problem as string | null) ?? null,
  delayReason: (row.delay_reason as string | null) ?? null,
})

const mintRow = (row: Row): MintRow => ({
  nonce: String(row.nonce),
  burnId: String(row.burn_id),
  status: row.status as MintStatus,
  suiTxDigest: (row.sui_tx_digest as string | null) ?? null,
  attempts: Number(row.attempts),
  lastError: (row.last_error as string | null) ?? null,
})

/** Hex is stored lowercase; every comparison in this service is byte-exact. */
function lower(value: string, bytes: number): string {
  const text = value.toLowerCase()
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(text))
    throw new Error(`expected 0x + ${bytes} bytes of hex, got ${value}`)
  return text
}

/**
 * One status change: assert it, apply it with any accompanying columns, and
 * record it with its evidence. `set` keys are literals from this module, never
 * caller-supplied names.
 */
async function move(
  tx: Queryable,
  entity: Entity,
  table: string,
  keyColumn: string,
  key: string,
  to: string,
  evidence: Evidence,
  set: Record<string, unknown> = {}
): Promise<void> {
  const current = await tx.maybeOne<{ status: string }>(
    `select status from ${table} where ${keyColumn} = $1 for update`,
    [key]
  )
  if (current === null) throw new Error(`${entity} ${key} does not exist`)
  assertTransition(entity, current.status as never, to as never)

  const columns = Object.keys(set)
  const assignments = [
    "status = $2",
    ...columns.map((c, i) => `${c} = $${i + 3}`),
  ]
  await tx.query(
    `update ${table} set ${assignments.join(", ")} where ${keyColumn} = $1`,
    [key, to, ...columns.map((c) => set[c])]
  )
  await tx.query(
    `insert into transitions (entity, entity_key, from_status, to_status, evidence)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [entity, key, current.status, to, JSON.stringify(evidence)]
  )
}

export type Journal = ReturnType<typeof openJournal>

export function openJournal(db: Db, network: Network) {
  const deposits = `
    id, sui_address, network, chain, forwarder_address, status, waiting_reason,
    last_balance, last_balance_at, hot_until, crank_attempts`
  const burns = `
    id, deposit_id, network, chain, tx_hash, burn_index, block_number, amount,
    status, nonce, message, attestation, max_fee, fee_executed, problem, delay_reason`

  return {
    network,

    /**
     * Binds a Sui recipient to an authenticated user. Sui does not validate a
     * mint recipient, so this binding is the only thing between a user and a
     * mint into the void (launch gate 7); it is recorded before any address is
     * derived.
     */
    async bindRecipient(args: {
      suiAddress: string
      userRef: string
    }): Promise<void> {
      await db.query(
        `insert into recipients (sui_address, user_ref) values ($1, $2)
         on conflict (sui_address) do update set user_ref = excluded.user_ref`,
        [lower(args.suiAddress, 32), args.userRef]
      )
    },

    async recipientDenyListed(suiAddress: string): Promise<boolean | null> {
      const row = await db.maybeOne<{
        deny_listed: boolean
        deny_checked_at: Date | null
      }>(
        "select deny_listed, deny_checked_at from recipients where sui_address = $1",
        [lower(suiAddress, 32)]
      )
      if (row === null || row.deny_checked_at === null) return null
      return row.deny_listed
    },

    async recordDenyCheck(
      suiAddress: string,
      denyListed: boolean
    ): Promise<void> {
      await db.query(
        `update recipients set deny_listed = $2, deny_checked_at = now()
         where sui_address = $1`,
        [lower(suiAddress, 32), denyListed]
      )
    },

    /**
     * The deposit address for a recipient on a chain, created on first ask.
     * Idempotent: the address is derived, never chosen, so a repeat issue must
     * return the same row rather than a second one.
     */
    async issueDeposit(args: {
      suiAddress: string
      chain: EvmChain
      forwarderAddress: string
    }): Promise<DepositRow> {
      const row = await db.one<Row>(
        `insert into deposits (sui_address, network, chain, forwarder_address)
         values ($1, $2, $3, $4)
         on conflict (sui_address, network, chain) do update
           set forwarder_address = deposits.forwarder_address
         returning ${deposits}`,
        [
          lower(args.suiAddress, 32),
          network,
          args.chain,
          lower(args.forwarderAddress, 20),
        ]
      )
      const deposit = depositRow(row)
      // A changed forwarder address for a live recipient means the build moved
      // under us. Refuse rather than issue an address the journal disagrees with.
      if (deposit.forwarderAddress !== lower(args.forwarderAddress, 20))
        throw new Error(
          `deposit ${deposit.id} is pinned to ${deposit.forwarderAddress}, ` +
            `refusing to reissue it as ${lower(args.forwarderAddress, 20)}`
        )
      return deposit
    },

    async findDeposit(args: {
      suiAddress: string
      chain: EvmChain
    }): Promise<DepositRow | null> {
      const row = await db.maybeOne<Row>(
        `select ${deposits} from deposits
         where sui_address = $1 and network = $2 and chain = $3`,
        [lower(args.suiAddress, 32), network, args.chain]
      )
      return row === null ? null : depositRow(row)
    },

    async depositById(id: string): Promise<DepositRow | null> {
      if (!/^\d+$/.test(id)) return null
      const row = await db.maybeOne<Row>(
        `select ${deposits} from deposits where id = $1 and network = $2`,
        [id, network]
      )
      return row === null ? null : depositRow(row)
    },

    /** Every deposit address issued to a recipient, one per chain. */
    async depositsFor(suiAddress: string): Promise<DepositRow[]> {
      const rows = await db.query<Row>(
        `select ${deposits} from deposits
         where sui_address = $1 and network = $2 order by chain`,
        [lower(suiAddress, 32), network]
      )
      return rows.map(depositRow)
    },

    /**
     * Deposits a crank was submitted for and whose burn has not been found
     * yet. Discovery scans these, rather than every address ever issued: the
     * reviewed discovery call filters by one depositor at a time, so the hot
     * path has to stay small. The slow sweep over everything belongs to the
     * reconciler.
     */
    async depositsAwaitingDiscovery(args: {
      chain: EvmChain
      limit: number
    }): Promise<DepositRow[]> {
      const rows = await db.query<Row>(
        `select ${deposits} from deposits
         where network = $1 and chain = $2 and status = 'cranking'
         order by last_crank_at asc nulls first
         limit $3`,
        [network, args.chain, args.limit]
      )
      return rows.map(depositRow)
    },

    async burnsForDeposit(depositId: string): Promise<BurnRow[]> {
      const rows = await db.query<Row>(
        `select ${burns} from burns where deposit_id = $1 order by id`,
        [depositId]
      )
      return rows.map(burnRow)
    },

    async mintByNonce(nonce: string): Promise<MintRow | null> {
      const row = await db.maybeOne<Row>(
        `select nonce, burn_id, status, sui_tx_digest, attempts, last_error
         from mints where nonce = $1`,
        [lower(nonce, 32)]
      )
      return row === null ? null : mintRow(row)
    },

    /** Row counts by status, for /metrics. */
    async counts(): Promise<{
      deposits: Record<string, number>
      burns: Record<string, number>
    }> {
      const tally = async (table: string) =>
        Object.fromEntries(
          (
            await db.query<{ status: string; n: string }>(
              `select status, count(*) as n from ${table}
               where network = $1 group by status`,
              [network]
            )
          ).map((row) => [row.status, Number(row.n)])
        )
      return { deposits: await tally("deposits"), burns: await tally("burns") }
    },

    /** The watcher's fast loop: addresses worth polling right now. */
    async hotDeposits(args: {
      chain: EvmChain
      limit: number
    }): Promise<DepositRow[]> {
      const rows = await db.query<Row>(
        `select ${deposits} from deposits
         where network = $1 and chain = $2 and hot_until > now()
         order by last_balance_at asc nulls first
         limit $3`,
        [network, args.chain, args.limit]
      )
      return rows.map(depositRow)
    },

    /** Marks an address worth watching closely, after an issue or a webhook. */
    async markHot(depositId: string, seconds: number): Promise<void> {
      await db.query(
        `update deposits
         set hot_until = greatest(coalesce(hot_until, now()), now() + make_interval(secs => $2))
         where id = $1`,
        [depositId, seconds]
      )
    },

    /**
     * Records an observed balance and, when it clears the floor, moves the
     * deposit to fundable. Returns the status the deposit now has.
     */
    async recordBalance(args: {
      depositId: string
      balance: bigint
      floor: bigint
    }): Promise<DepositStatus> {
      return db.transaction(async (tx) => {
        const row = await tx.one<Row>(
          `update deposits set last_balance = $2, last_balance_at = now()
           where id = $1 returning ${deposits}`,
          [args.depositId, args.balance.toString()]
        )
        const deposit = depositRow(row)
        const fundable = args.balance >= args.floor
        const to: DepositStatus | null = fundable
          ? deposit.status === "issued" ||
            deposit.status === "cranked" ||
            deposit.status === "waiting"
            ? "fundable"
            : null
          : deposit.status === "fundable"
            ? "issued"
            : null
        if (to === null) return deposit.status
        await move(tx, "deposit", "deposits", "id", args.depositId, to, {
          balance: args.balance.toString(),
          floor: args.floor.toString(),
        })
        return to
      })
    },

    /**
     * Claims a deposit for cranking, holding its advisory lock. Returns null
     * when another worker holds it or it is not fundable, so two crankers never
     * pay gas for the same address at the same moment.
     */
    async claimForCrank(depositId: string): Promise<DepositRow | null> {
      const result = await db.withLock(`crank:${depositId}`, async (tx) => {
        const row = await tx.maybeOne<Row>(
          `select ${deposits} from deposits where id = $1 for update`,
          [depositId]
        )
        if (row === null) return null
        const deposit = depositRow(row)
        if (deposit.status !== "fundable" && deposit.status !== "waiting")
          return null
        await move(
          tx,
          "deposit",
          "deposits",
          "id",
          depositId,
          "cranking",
          { attempt: deposit.crankAttempts + 1 },
          {
            crank_attempts: deposit.crankAttempts + 1,
            last_crank_at: new Date(),
            waiting_reason: null,
          }
        )
        // Re-read rather than patching the row we hold: it was captured before
        // the update, so its attempt count and timestamps are already stale.
        const updated = await tx.one<Row>(
          `select ${deposits} from deposits where id = $1`,
          [depositId]
        )
        return depositRow(updated)
      })
      return result === NOT_ACQUIRED ? null : result
    },

    /**
     * A crank that Circle refused. The USDC stays where it is and the same
     * crank succeeds once the condition is lifted, so this is not a failure
     * state, only a reason to wait.
     */
    async markWaiting(depositId: string, reason: string): Promise<void> {
      await db.transaction((tx) =>
        move(
          tx,
          "deposit",
          "deposits",
          "id",
          depositId,
          "waiting",
          { reason },
          { waiting_reason: reason }
        )
      )
    },

    /** A crank that did not land, with no evidence Circle refused it. */
    async releaseCrank(depositId: string, why: string): Promise<void> {
      await db.transaction((tx) =>
        move(tx, "deposit", "deposits", "id", depositId, "fundable", { why })
      )
    },

    /**
     * Records a forwarder burn, found at the finalized block. Idempotent on
     * (chain, tx hash, log index): rediscovery after a restart must not create
     * a second burn. Moves the deposit to cranked, which is the only evidence
     * that a crank actually happened — a DepositForBurn log whose depositor is
     * the deposit address.
     */
    async recordBurn(args: {
      depositId: string
      chain: EvmChain
      txHash: string
      burnIndex: number
      blockNumber: bigint
      amount: bigint
    }): Promise<{ burn: BurnRow; isNew: boolean }> {
      return db.transaction(async (tx) => {
        const existing = await tx.maybeOne<Row>(
          `select ${burns} from burns where chain = $1 and tx_hash = $2 and burn_index = $3`,
          [args.chain, lower(args.txHash, 32), args.burnIndex]
        )
        if (existing !== null) return { burn: burnRow(existing), isNew: false }

        const row = await tx.one<Row>(
          `insert into burns
             (deposit_id, network, chain, tx_hash, burn_index, block_number, amount)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning ${burns}`,
          [
            args.depositId,
            network,
            args.chain,
            lower(args.txHash, 32),
            args.burnIndex,
            args.blockNumber.toString(),
            args.amount.toString(),
          ]
        )
        const burn = burnRow(row)
        await tx.query(
          `insert into transitions (entity, entity_key, from_status, to_status, evidence)
           values ('burn', $1, null, 'discovered', $2::jsonb)`,
          [
            burn.id,
            JSON.stringify({
              txHash: burn.txHash,
              burnIndex: burn.burnIndex,
              amount: burn.amount.toString(),
              blockNumber: burn.blockNumber.toString(),
            }),
          ]
        )
        const deposit = await tx.one<{ status: string }>(
          "select status from deposits where id = $1 for update",
          [args.depositId]
        )
        if (deposit.status === "cranking" || deposit.status === "fundable")
          await move(
            tx,
            "deposit",
            "deposits",
            "id",
            args.depositId,
            "cranked",
            {
              burnId: burn.id,
              txHash: burn.txHash,
            }
          )
        return { burn, isNew: true }
      })
    },

    /** Iris has the transaction but not a signed message yet. */
    async markAttesting(
      burnId: string,
      delayReason: string | null
    ): Promise<void> {
      await db.transaction((tx) =>
        move(
          tx,
          "burn",
          "burns",
          "id",
          burnId,
          "attesting",
          { delayReason },
          { delay_reason: delayReason }
        )
      )
    },

    /**
     * An attested message that `forwarderBurnProblem` accepted. The nonce is
     * Circle's and is the exactly-once key for the mint.
     */
    async recordAttestation(args: {
      burnId: string
      nonce: string
      message: Uint8Array
      attestation: Uint8Array
      maxFee: bigint
      feeExecuted: bigint
    }): Promise<void> {
      await db.transaction((tx) =>
        move(
          tx,
          "burn",
          "burns",
          "id",
          args.burnId,
          "validated",
          {
            nonce: lower(args.nonce, 32),
            feeExecuted: args.feeExecuted.toString(),
          },
          {
            nonce: lower(args.nonce, 32),
            message: Buffer.from(args.message),
            attestation: Buffer.from(args.attestation),
            max_fee: args.maxFee.toString(),
            fee_executed: args.feeExecuted.toString(),
            attested_at: new Date(),
          }
        )
      )
    },

    /**
     * An attested message that is not the burn this forwarder emits. It is
     * never minted; the schema refuses a mint for it and the reconciler pages.
     */
    async quarantineBurn(burnId: string, problem: string): Promise<void> {
      await db.transaction((tx) =>
        move(
          tx,
          "burn",
          "burns",
          "id",
          burnId,
          "quarantined",
          { problem },
          { problem }
        )
      )
    },

    async burnsByStatus(status: BurnStatus, limit: number): Promise<BurnRow[]> {
      const rows = await db.query<Row>(
        `select ${burns} from burns where network = $1 and status = $2
         order by discovered_at asc limit $3`,
        [network, status, limit]
      )
      return rows.map(burnRow)
    },

    /**
     * Claims a validated burn for minting, under the nonce's advisory lock.
     * Returns null when another worker holds it or it is already claimed: the
     * mints row is keyed by nonce, so a second claim cannot be represented.
     */
    async claimForMint(burn: BurnRow): Promise<MintRow | null> {
      if (burn.nonce === null) throw new Error(`burn ${burn.id} has no nonce`)
      const nonce = lower(burn.nonce, 32)
      const result = await db.withLock(`mint:${nonce}`, async (tx) => {
        const row = await tx.one<Row>(
          `insert into mints (nonce, burn_id, attempts)
           values ($1, $2, 1)
           on conflict (nonce) do update set attempts = mints.attempts + 1
           returning nonce, burn_id, status, sui_tx_digest, attempts, last_error`,
          [nonce, burn.id]
        )
        const mint = mintRow(row)
        if (mint.status === "confirmed") return null
        await move(tx, "burn", "burns", "id", burn.id, "minting", {
          nonce,
          attempt: mint.attempts,
        })
        return mint
      })
      return result === NOT_ACQUIRED ? null : result
    },

    async markMintSubmitted(nonce: string, suiTxDigest: string): Promise<void> {
      await db.transaction((tx) =>
        move(
          tx,
          "mint",
          "mints",
          "nonce",
          lower(nonce, 32),
          "submitted",
          { suiTxDigest },
          { sui_tx_digest: suiTxDigest, submitted_at: new Date() }
        )
      )
    },

    /** The mint is on Sui. Confirmed by the nonce flag, not by our own receipt. */
    async markMintConfirmed(args: {
      nonce: string
      burnId: string
      suiTxDigest: string
    }): Promise<void> {
      const nonce = lower(args.nonce, 32)
      await db.transaction(async (tx) => {
        await move(
          tx,
          "mint",
          "mints",
          "nonce",
          nonce,
          "confirmed",
          { suiTxDigest: args.suiTxDigest },
          { sui_tx_digest: args.suiTxDigest, confirmed_at: new Date() }
        )
        await move(tx, "burn", "burns", "id", args.burnId, "minted", {
          nonce,
          suiTxDigest: args.suiTxDigest,
        })
      })
    },

    /**
     * A submission that failed or whose outcome is unknown, with the nonce
     * since read unused. The message goes back to validated and is retried; it
     * is never dropped.
     */
    async releaseMint(args: {
      nonce: string
      burnId: string
      error: string
    }): Promise<void> {
      const nonce = lower(args.nonce, 32)
      await db.transaction(async (tx) => {
        await tx.query("update mints set last_error = $2 where nonce = $1", [
          nonce,
          args.error,
        ])
        await move(tx, "burn", "burns", "id", args.burnId, "validated", {
          nonce,
          error: args.error,
        })
      })
    },

    /**
     * The nonce reads used on Sui and we did not submit it. Minting is
     * permissionless, so anyone may have delivered the transfer; it is
     * delivered either way. No mints row is written, because mints records this
     * service's own submissions.
     */
    async markDeliveredElsewhere(burnId: string, nonce: string): Promise<void> {
      await db.transaction((tx) =>
        move(tx, "burn", "burns", "id", burnId, "minted", {
          nonce: lower(nonce, 32),
          deliveredBy: "another caller",
        })
      )
    },

    async markReconciled(burnId: string, evidence: Evidence): Promise<void> {
      await db.transaction((tx) =>
        move(tx, "burn", "burns", "id", burnId, "reconciled", evidence)
      )
    },

    /** Scan progress. Never moves backwards, so a stale worker cannot rewind it. */
    async advanceCursor(args: {
      name: string
      chain: EvmChain
      block: bigint
    }): Promise<bigint> {
      const row = await db.one<{ block_number: string }>(
        `insert into cursors (name, network, chain, block_number)
         values ($1, $2, $3, $4)
         on conflict (name, network, chain) do update
           set block_number = greatest(cursors.block_number, excluded.block_number),
               updated_at = now()
         returning block_number`,
        [args.name, network, args.chain, args.block.toString()]
      )
      return big(row.block_number)
    },

    async cursor(name: string, chain: EvmChain): Promise<bigint | null> {
      const row = await db.maybeOne<{ block_number: string }>(
        `select block_number from cursors
         where name = $1 and network = $2 and chain = $3`,
        [name, network, chain]
      )
      return row === null ? null : big(row.block_number)
    },

    /** Opens an alert, or returns false if this one is already open. */
    async openAlert(args: {
      kind: string
      subject: string
      payload?: Evidence
    }): Promise<boolean> {
      const rows = await db.query<{ id: string }>(
        `insert into alerts (kind, subject, network, payload)
         values ($1, $2, $3, $4::jsonb)
         on conflict do nothing
         returning id`,
        [args.kind, args.subject, network, JSON.stringify(args.payload ?? {})]
      )
      return rows.length === 1
    },

    async closeAlert(kind: string, subject: string): Promise<void> {
      await db.query(
        `update alerts set closed_at = now()
         where kind = $1 and subject = $2 and network = $3 and closed_at is null`,
        [kind, subject, network]
      )
    },

    async openAlerts(): Promise<Array<{ kind: string; subject: string }>> {
      return db.query<{ kind: string; subject: string }>(
        `select kind, subject from alerts
         where network = $1 and closed_at is null order by opened_at`,
        [network]
      )
    },

    /** The audit trail for one row, oldest first. */
    async history(
      entity: Entity,
      key: string
    ): Promise<
      Array<{ from: string | null; to: string; evidence: unknown; at: Date }>
    > {
      const rows = await db.query<Row>(
        `select from_status, to_status, evidence, at from transitions
         where entity = $1 and entity_key = $2 order by id`,
        [entity, key]
      )
      return rows.map((row) => ({
        from: (row.from_status as string | null) ?? null,
        to: String(row.to_status),
        evidence: row.evidence,
        at: row.at as Date,
      }))
    },
  }
}
