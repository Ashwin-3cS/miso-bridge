import { describe, expect, it, vi } from "vitest"
import { loopsFor, roles, type Parts, type Role } from "../src/main.js"
import { loadConfig } from "../src/config.js"
import type { Journal } from "../src/journal.js"
import type { AlertSink, Logger } from "../src/observability.js"

/**
 * The role wiring. What matters is that a role builds only what it needs: a
 * read-only staging run of discovery and Iris must start with no signing key
 * at all, and a key that is missing for the role that needs it must fail with
 * that role named rather than on the first transfer.
 */

const config = loadConfig({
  NETWORK: "mainnet",
  DATABASE_URL: "postgres://unused",
  AVALANCHE_RPC_URL: "https://a.test",
  POLYGON_RPC_URL: "https://b.test",
  SUI_RPC_URL: "https://c.test",
  API_SHARED_SECRET: "s",
})

function parts(): Parts {
  const noop = vi.fn()
  return {
    config,
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    } as unknown as Logger,
    journal: {} as Journal,
    alerts: {} as AlertSink,
    chains: ["avalanche", "polygon"],
    instance: "0xC23f642716fDd5301E6F36e5007093A288581B9E",
    usdc: () => "0x" + "1".repeat(40),
    // Building an RPC client opens no connection, so a tick may do it freely.
    rpc: () => ({ chain: "avalanche" }),
    signer: () => {
      throw new Error("AVALANCHE_CRANK_KEY is required to crank")
    },
    sui: () => {
      throw new Error("SUI_MINT_KEY is required to mint")
    },
  } as unknown as Parts
}

const names = (role: Role): string[] =>
  loopsFor(role, parts()).map((loop) => loop.name)

describe("loopsFor", () => {
  it("gives the API no loops at all", () => {
    expect(names("api")).toEqual([])
  })

  it("runs one loop per chain for the per-chain roles", () => {
    expect(names("watcher")).toEqual(["watcher:avalanche", "watcher:polygon"])
    expect(names("crank")).toEqual(["crank:avalanche", "crank:polygon"])
    expect(names("discover")).toEqual([
      "discover:avalanche",
      "discover:polygon",
    ])
    expect(names("iris")).toEqual(["iris:avalanche", "iris:polygon"])
  })

  it("runs one mint loop, because Sui is one chain", () => {
    expect(names("mint")).toEqual(["mint"])
  })

  it("pairs the reconciler with the slow sweep", () => {
    expect(names("reconcile")).toEqual([
      "reconcile",
      "sweep:avalanche",
      "sweep:polygon",
    ])
  })

  it("covers every loop under `all`, with no duplicates", () => {
    const all = names("all")
    expect(new Set(all).size).toBe(all.length)
    for (const role of roles)
      if (role !== "all" && role !== "api")
        for (const name of names(role)) expect(all).toContain(name)
  })

  it("requires no key to wire a role up", () => {
    // Construction must not need a signer; a role that cannot run should fail
    // on its first tick, with the reason. This is what lets a read-only
    // staging run of discovery and Iris start with no keys at all.
    expect(() => loopsFor("all", parts())).not.toThrow()
  })

  it("names the missing key when a tick needs it", async () => {
    const crank = loopsFor("crank", parts())[0]
    await expect(crank?.tick()).rejects.toThrow(
      "AVALANCHE_CRANK_KEY is required"
    )
    const mint = loopsFor("mint", parts())[0]
    await expect(mint?.tick()).rejects.toThrow("SUI_MINT_KEY is required")
  })

  it("ticks faster than Circle attests, and sweeps far slower", () => {
    const interval = (role: Role) => loopsFor(role, parts())[0]?.interval ?? 0
    expect(interval("watcher")).toBeLessThanOrEqual(5_000)
    expect(interval("iris")).toBeLessThanOrEqual(5_000)
    expect(interval("reconcile")).toBeGreaterThanOrEqual(30_000)
  })
})
