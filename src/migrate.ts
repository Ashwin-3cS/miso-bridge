import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { loadDatabaseConfig } from "./config.js"
import { openDb, type Db } from "./db.js"

/**
 * Applies `migrations/*.sql` in filename order, once each, inside a
 * transaction.
 *
 * An applied migration's checksum is recorded and re-checked. Editing a file
 * that has already run is a deploy that would leave two databases with the
 * same version number and different shapes, so it fails loudly rather than
 * silently skipping.
 */

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url))

export type Migration = { name: string; sql: string; checksum: string }

export async function readMigrations(
  dir = migrationsDir
): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(`${dir}/${name}`, "utf8")
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      }
    })
  )
}

export async function migrate(
  db: Db,
  migrations: Migration[],
  log: (message: string) => void = console.log
): Promise<string[]> {
  await db.query(`
    create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `)
  const applied = new Map(
    (
      await db.query<{ name: string; checksum: string }>(
        "select name, checksum from schema_migrations"
      )
    ).map((row) => [row.name, row.checksum])
  )

  const ran: string[] = []
  for (const migration of migrations) {
    const seen = applied.get(migration.name)
    if (seen !== undefined) {
      if (seen !== migration.checksum)
        throw new Error(
          `${migration.name} changed after it was applied ` +
            `(recorded ${seen.slice(0, 12)}, now ${migration.checksum.slice(0, 12)}); ` +
            `add a new migration instead of editing this one`
        )
      continue
    }
    await db.transaction(async (tx) => {
      await tx.query(migration.sql)
      await tx.query(
        "insert into schema_migrations (name, checksum) values ($1, $2)",
        [migration.name, migration.checksum]
      )
    })
    log(`applied ${migration.name}`)
    ran.push(migration.name)
  }
  if (ran.length === 0) log("already up to date")
  return ran
}

if (import.meta.main) {
  const db = openDb(loadDatabaseConfig())
  try {
    await migrate(db, await readMigrations())
  } finally {
    await db.close()
  }
}
