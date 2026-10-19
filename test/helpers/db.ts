import { Secret } from "../../src/config.js"
import { openDb, type Db } from "../../src/db.js"
import { migrate, readMigrations } from "../../src/migrate.js"

/**
 * A migrated database in a schema of its own.
 *
 * vitest runs test files in parallel, so two files sharing one schema truncate
 * each other's rows mid-test. A schema per file keeps the isolation without
 * serialising the suite.
 */
export async function openIsolatedDb(url: string, schema: string): Promise<Db> {
  const admin = openDb({ DATABASE_URL: new Secret(url) })
  try {
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.query(`create schema ${schema}`)
  } finally {
    await admin.close()
  }
  const db = openDb({ DATABASE_URL: new Secret(url) }, { schema })
  await migrate(db, await readMigrations(), () => {})
  return db
}

export const truncateAll = (db: Db) =>
  db.query(
    `truncate transitions, mints, burns, deposits, recipients, cursors, alerts
     restart identity cascade`
  )
