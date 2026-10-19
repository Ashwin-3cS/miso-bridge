import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  assertTransition,
  burnStatuses,
  depositStatuses,
  isAllowed,
  mintStatuses,
  reachable,
  statusesOf,
  terminal,
  validatedFamily,
  type Entity,
} from "../src/transitions.js"

const schema = readFileSync(
  fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url)),
  "utf8"
)

/** The quoted values of the first `status in (...)` list after `create table <name>`. */
function statusesInSchema(table: string): string[] {
  const from = schema.indexOf(`create table ${table} (`)
  expect(from, `${table} is not in the schema`).toBeGreaterThan(-1)
  const list = schema
    .slice(from)
    .match(/status\s+text\s+not null[\s\S]*?in \(([^)]*)\)/)
  expect(list?.[1], `${table} has no status list`).toBeDefined()
  return [...(list?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map(
    (m) => m[1] as string
  )
}

describe("the status lists match the schema", () => {
  it.each([
    ["deposits", depositStatuses],
    ["burns", burnStatuses],
    ["mints", mintStatuses],
  ])("%s", (table, statuses) => {
    expect(statusesInSchema(table).sort()).toEqual([...statuses].sort())
  })

  it("validatedFamily matches the attested_has_message constraint", () => {
    const constraint = schema.slice(
      schema.indexOf("constraint attested_has_message")
    )
    const listed = [...constraint.slice(0, 200).matchAll(/'([a-z]+)'/g)].map(
      (m) => m[1] as string
    )
    expect(listed.sort()).toEqual([...validatedFamily].sort())
  })
})

describe("transitions", () => {
  const entities: Entity[] = ["deposit", "burn", "mint"]

  it.each(entities)(
    "%s: a repeated move is a no-op, not an error",
    (entity) => {
      for (const status of statusesOf(entity))
        expect(isAllowed(entity, status as never, status as never)).toBe(true)
    }
  )

  it.each(entities)("%s: terminal statuses have no way out", (entity) => {
    for (const status of terminal[entity])
      for (const other of statusesOf(entity))
        if (other !== status)
          expect(isAllowed(entity, status as never, other as never)).toBe(false)
  })

  it("every deposit status is reachable from issued", () => {
    for (const status of depositStatuses)
      expect(reachable("deposit", "issued", status)).toBe(true)
  })

  it("every burn status is reachable from discovered", () => {
    for (const status of burnStatuses)
      expect(reachable("burn", "discovered", status)).toBe(true)
  })

  it("names the legal moves when it refuses", () => {
    expect(() => assertTransition("burn", "discovered", "minted")).toThrow(
      "from discovered it may move to attesting, validated, quarantined"
    )
    expect(() => assertTransition("burn", "quarantined", "validated")).toThrow(
      "nothing (terminal)"
    )
  })

  describe("the safety properties", () => {
    it("a quarantined burn can never be minted, by any route", () => {
      expect(reachable("burn", "quarantined", "minted")).toBe(false)
      expect(reachable("burn", "quarantined", "minting")).toBe(false)
    })

    it("a burn cannot be minted without validating first", () => {
      for (const status of ["discovered", "attesting"] as const) {
        expect(isAllowed("burn", status, "minted")).toBe(false)
        expect(isAllowed("burn", status, "minting")).toBe(false)
      }
    })

    it("a reconciled burn is settled history", () => {
      for (const status of burnStatuses)
        if (status !== "reconciled")
          expect(isAllowed("burn", "reconciled", status)).toBe(false)
    })

    it("minting can retry but a confirmed mint cannot be reopened", () => {
      expect(isAllowed("burn", "minting", "validated")).toBe(true)
      expect(isAllowed("mint", "submitted", "submitting")).toBe(true)
      expect(isAllowed("mint", "confirmed", "submitting")).toBe(false)
    })

    it("a waiting deposit always leads back to another attempt", () => {
      expect(reachable("deposit", "waiting", "cranked")).toBe(true)
    })
  })
})
