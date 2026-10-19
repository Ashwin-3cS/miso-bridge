import { Pool, type PoolClient, type QueryResultRow } from "pg"
import type { Config } from "./config.js"

/**
 * Postgres access: a pool, transactions, and the advisory locks that make a
 * worker single-flight per subject.
 *
 * Numeric columns come back as strings and stay strings here. This service
 * handles uint256 amounts and block numbers, which no JavaScript number can
 * hold, and a global pg type parser that returned bigints would make every
 * row unloggable (`JSON.stringify` throws on a bigint). Conversion is
 * explicit, at the journal boundary, through `big`.
 *
 * `openDb` takes only the database URL, so a migration job does not have to
 * supply RPC endpoints it will never use.
 */

/** A numeric column as a bigint; throws on anything that is not an integer. */
export function big(value: string | number | bigint | null): bigint {
  if (value === null) throw new Error("expected a numeric value, got null")
  const text = String(value)
  if (!/^-?\d+$/.test(text)) throw new Error(`not an integer: ${text}`)
  return BigInt(text)
}

export type Queryable = {
  query<Row extends QueryResultRow>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<Row[]>
  /** Exactly one row, or an error naming how many came back. */
  one<Row extends QueryResultRow>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<Row>
  /** One row or null; an error if more than one. */
  maybeOne<Row extends QueryResultRow>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<Row | null>
}

/** Returned instead of a result when another holder has the lock. */
export const NOT_ACQUIRED = Symbol("lock not acquired")
export type NotAcquired = typeof NOT_ACQUIRED

export type Db = Queryable & {
  /** Runs `body` in a transaction, committing on return and rolling back on throw. */
  transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>
  /**
   * Runs `body` in a transaction holding the transaction-scoped advisory lock
   * for `subject`, or returns NOT_ACQUIRED immediately if someone else holds
   * it. The lock is released by the transaction ending, including on a crash,
   * so a dead worker cannot wedge a deposit.
   */
  withLock<T>(
    subject: string,
    body: (tx: Queryable) => Promise<T>
  ): Promise<T | NotAcquired>
  healthy(): Promise<boolean>
  close(): Promise<void>
}

function wrap(run: Queryable["query"]): Queryable {
  const query = run
  return {
    query,
    async one(sql, params) {
      const rows = await query(sql, params)
      if (rows.length !== 1)
        throw new Error(`expected exactly 1 row, got ${rows.length}`)
      return rows[0] as never
    },
    async maybeOne(sql, params) {
      const rows = await query(sql, params)
      if (rows.length > 1)
        throw new Error(`expected at most 1 row, got ${rows.length}`)
      return (rows[0] ?? null) as never
    },
  }
}

export type DbOptions = {
  /**
   * A schema to resolve unqualified names in, for every connection in the
   * pool. Test files use one each so they can truncate freely in parallel.
   */
  schema?: string
}

export function openDb(
  config: Pick<Config, "DATABASE_URL">,
  options: DbOptions = {}
): Db {
  if (
    options.schema !== undefined &&
    !/^[a-z_][a-z0-9_]*$/.test(options.schema)
  )
    throw new Error(`unsafe schema name: ${options.schema}`)
  const pool = new Pool({
    connectionString: config.DATABASE_URL.reveal(),
    ...(options.schema === undefined
      ? {}
      : { options: `-c search_path=${options.schema}` }),
    max: 10,
    // A worker that cannot get a connection should fail and retry, not queue.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })

  const onPool = wrap(async (sql, params) => {
    const result = await pool.query(sql, params as unknown[])
    return result.rows
  })

  const onClient = (client: PoolClient) =>
    wrap(async (sql, params) => {
      const result = await client.query(sql, params as unknown[])
      return result.rows
    })

  async function inTransaction<T>(
    body: (tx: Queryable, client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query("begin")
      const result = await body(onClient(client), client)
      await client.query("commit")
      return result
    } catch (error) {
      try {
        await client.query("rollback")
      } catch {
        // The connection is already gone; the transaction is rolled back.
      }
      throw error
    } finally {
      client.release()
    }
  }

  return {
    ...onPool,
    transaction: (body) => inTransaction((tx) => body(tx)),
    withLock: (subject, body) =>
      inTransaction(async (tx, client) => {
        // hashtextextended gives a stable bigint key from the subject, so
        // callers name a deposit or a nonce rather than allocating lock ids.
        const { locked } = await onClient(client).one<{ locked: boolean }>(
          "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked",
          [subject]
        )
        if (!locked) return NOT_ACQUIRED
        return body(tx)
      }),
    async healthy() {
      try {
        await onPool.query("select 1")
        return true
      } catch {
        return false
      }
    },
    close: () => pool.end(),
  }
}
