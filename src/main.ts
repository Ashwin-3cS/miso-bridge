import type { EvmChain } from "@misofm/cctp-forwarders/evm-forwarder"
import type { Hex } from "viem"
import { createRouter } from "./api/routes.js"
import { createEvmRpc, type EvmRpc } from "./chain/evm.js"
import { openSigner, type Signer } from "./chain/signer.js"
import { openSuiMinter, type SuiMinter } from "./chain/sui.js"
import { describeConfig, loadConfig, type Config } from "./config.js"
import { openDb, type Db } from "./db.js"
import { chainsFor, forwarderBuild, usdcFor } from "./forwarder.js"
import { openJournal, type Journal } from "./journal.js"
import {
  createAlertSink,
  createLogger,
  type AlertSink,
  type Logger,
} from "./observability.js"
import { crankPendingOnce } from "./workers/crank.js"
import { discoverOnce } from "./workers/discover.js"
import { irisOnce } from "./workers/iris.js"
import { runLoop } from "./workers/loop.js"
import { mintOnce } from "./workers/mint.js"
import { reconcileOnce } from "./workers/reconcile.js"
import { sweepOnce } from "./workers/sweep.js"
import { watchOnce } from "./workers/watcher.js"

/**
 * The entry point. One process per role, or `all` for development.
 *
 *   bun run src/main.ts api|watcher|crank|discover|iris|mint|reconcile|all
 *
 * A role builds only what it needs, so a read-only staging run of discovery
 * and Iris starts without any signing key at all, and a missing key fails at
 * boot with the role named rather than on the first transfer.
 *
 * Every loop is independent and idempotent. Running two of the same role is
 * safe -- claims are taken under advisory locks and the mints table is keyed
 * by nonce -- and a role that dies leaves the others working.
 */

export const roles = [
  "api",
  "watcher",
  "crank",
  "discover",
  "iris",
  "mint",
  "reconcile",
  "all",
] as const
export type Role = (typeof roles)[number]

/**
 * Tick intervals. The fast loops are fast because a user is watching: Circle's
 * Standard attestation from these chains is seconds, so the service's own
 * polling should not be the slow part. The slow ones are slow because they
 * cost RPC calls per address.
 */
const intervals = {
  watcher: 3_000,
  crank: 2_000,
  discover: 15_000,
  iris: 5_000,
  mint: 5_000,
  reconcile: 60_000,
  sweep: 300_000,
} as const

export type Parts = {
  config: Config
  logger: Logger
  journal: Journal
  alerts: AlertSink
  chains: readonly EvmChain[]
  rpc(chain: EvmChain): EvmRpc
  signer(chain: EvmChain): Signer
  sui(): SuiMinter
  usdc(chain: EvmChain): string
  instance: Hex
}

function build(
  config: Config,
  logger: Logger
): { parts: Parts; db: Db; close(): Promise<void> } {
  const db = openDb(config)
  const journal = openJournal(db, config.NETWORK)
  const alerts = createAlertSink({
    journal,
    logger,
    webhookUrl: config.ALERT_WEBHOOK_URL,
  })

  const rpcUrls: Record<EvmChain, string> = {
    avalanche: config.AVALANCHE_RPC_URL,
    polygon: config.POLYGON_RPC_URL,
  }
  const crankKeys = {
    avalanche: config.AVALANCHE_CRANK_KEY,
    polygon: config.POLYGON_CRANK_KEY,
  }
  const maxFeeGwei = {
    avalanche: config.AVALANCHE_MAX_FEE_GWEI,
    polygon: config.POLYGON_MAX_FEE_GWEI,
  }

  const rpcs = new Map<EvmChain, EvmRpc>()
  const signers = new Map<EvmChain, Signer>()

  const parts: Parts = {
    config,
    logger,
    journal,
    alerts,
    chains: chainsFor(config.NETWORK),
    instance: forwarderBuild(config.NETWORK).instance as Hex,
    usdc: (chain) => usdcFor(config.NETWORK, chain),
    rpc(chain) {
      const existing = rpcs.get(chain)
      if (existing !== undefined) return existing
      const rpc = createEvmRpc({ url: rpcUrls[chain], chain })
      rpcs.set(chain, rpc)
      return rpc
    },
    signer(chain) {
      const existing = signers.get(chain)
      if (existing !== undefined) return existing
      const key = crankKeys[chain]
      if (key === undefined)
        throw new Error(`${chain.toUpperCase()}_CRANK_KEY is required to crank`)
      const signer = openSigner({
        key,
        network: config.NETWORK,
        chain,
        rpcUrl: rpcUrls[chain],
        maxFeeGwei: maxFeeGwei[chain],
      })
      signers.set(chain, signer)
      return signer
    },
    sui() {
      if (config.SUI_MINT_KEY === undefined)
        throw new Error("SUI_MINT_KEY is required to mint")
      return openSuiMinter({
        key: config.SUI_MINT_KEY,
        network: config.NETWORK,
        rpcUrl: config.SUI_RPC_URL,
      })
    },
  }

  return { parts, db, close: () => db.close() }
}

/** Each role as a list of named loops, so `all` is just their concatenation. */
export function loopsFor(
  role: Role,
  parts: Parts
): Array<{ name: string; interval: number; tick: () => Promise<void> }> {
  const { config, logger, journal, alerts } = parts
  const loops: Array<{
    name: string
    interval: number
    tick: () => Promise<void>
  }> = []
  const want = (...wanted: Role[]) => role === "all" || wanted.includes(role)

  if (want("watcher"))
    for (const chain of parts.chains)
      loops.push({
        name: `watcher:${chain}`,
        interval: intervals.watcher,
        tick: async () => {
          const result = await watchOnce({
            journal,
            rpc: parts.rpc(chain),
            chain,
            usdc: parts.usdc(chain),
            floor: config.CRANK_FLOOR_USDC,
          })
          if (result.fundable.length > 0)
            logger.info("watcher", { chain, ...result })
        },
      })

  if (want("crank"))
    for (const chain of parts.chains)
      loops.push({
        name: `crank:${chain}`,
        interval: intervals.crank,
        tick: async () => {
          const outcomes = await crankPendingOnce({
            journal,
            rpc: parts.rpc(chain),
            signer: parts.signer(chain),
            instance: parts.instance,
            budget: config.CRANK_BUDGET_PER_DEPOSIT,
            chain,
          })
          for (const outcome of outcomes) {
            if (outcome.kind === "skipped") continue
            logger.info("crank", { chain, ...outcome })
            if (outcome.kind === "waiting" && outcome.alert)
              await alerts.raise({
                kind: "crank-refused",
                subject: `chain:${chain}`,
                severity: "page",
                payload: { reason: outcome.reason },
              })
          }
        },
      })

  if (want("discover"))
    for (const chain of parts.chains)
      loops.push({
        name: `discover:${chain}`,
        interval: intervals.discover,
        tick: async () => {
          const result = await discoverOnce({
            journal,
            rpc: parts.rpc(chain),
            chain,
            windowBlocks: config.DISCOVER_WINDOW_BLOCKS,
            maxWindows: config.DISCOVER_MAX_WINDOWS,
          })
          if (result.found > 0 || result.behind)
            logger.info("discover", { chain, ...result })
        },
      })

  if (want("iris"))
    for (const chain of parts.chains)
      loops.push({
        name: `iris:${chain}`,
        interval: intervals.iris,
        tick: async () => {
          const outcomes = await irisOnce({
            journal,
            fetchFn: fetch,
            chain,
            baseUrl: config.IRIS_BASE_URL,
          })
          for (const outcome of outcomes)
            if (outcome.kind !== "not-indexed" && outcome.kind !== "pending")
              logger.info("iris", { chain, ...outcome })
        },
      })

  if (want("mint"))
    loops.push({
      name: "mint",
      interval: intervals.mint,
      tick: async () => {
        const outcomes = await mintOnce({ journal, sui: parts.sui() })
        for (const outcome of outcomes)
          if (outcome.kind !== "skipped") logger.info("mint", outcome)
      },
    })

  if (want("reconcile")) {
    loops.push({
      name: "reconcile",
      interval: intervals.reconcile,
      tick: async () => {
        const report = await reconcileOnce({
          journal,
          alerts,
          deadlines: {
            crankSeconds: config.CRANK_DEADLINE_SECONDS,
            attestSeconds: config.ATTEST_DEADLINE_SECONDS,
            mintSeconds: config.MINT_DEADLINE_SECONDS,
            waitingSeconds: config.ATTEST_DEADLINE_SECONDS,
          },
        })
        logger.debug("reconcile", report)
      },
    })

    // The slow sweep over every address ever issued, one page per tick,
    // carrying its position so it comes back around.
    const positions = new Map<EvmChain, string>()
    for (const chain of parts.chains)
      loops.push({
        name: `sweep:${chain}`,
        interval: intervals.sweep,
        tick: async () => {
          const result = await sweepOnce({
            journal,
            rpc: parts.rpc(chain),
            chain,
            usdc: parts.usdc(chain),
            floor: config.CRANK_FLOOR_USDC,
            afterId: positions.get(chain) ?? "0",
          })
          positions.set(chain, result.nextAfterId)
          for (const found of result.funded)
            await alerts.raise({
              kind: "balance-at-issued-address",
              subject: `deposit:${found.depositId}`,
              severity: "notice",
              payload: {
                address: found.address,
                balance: found.balance.toString(),
              },
            })
        },
      })
  }

  return loops
}

if (import.meta.main) {
  const role = (process.argv[2] ?? "all") as Role
  if (!roles.includes(role)) {
    console.error(`unknown role ${role}; one of ${roles.join(", ")}`)
    process.exit(2)
  }

  const config = loadConfig()
  const logger = createLogger({
    level: config.LOG_LEVEL,
    network: config.NETWORK,
  })
  const { parts, db, close } = build(config, logger)
  logger.info("boot", { role, config: describeConfig(config) })

  const controller = new AbortController()
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      logger.info("shutdown", { signal })
      controller.abort()
    })

  const running: Array<Promise<void>> = []

  if (role === "api" || role === "all") {
    const handle = createRouter({
      config,
      db,
      journal: parts.journal,
    })
    const server = Bun.serve({ port: config.API_PORT, fetch: handle })
    logger.info("listening", { port: server.port })
    // Serving is not a loop, so without this the role would fall off the end
    // of main, close the pool, and answer /readyz with a dead database while
    // still holding the port.
    running.push(
      new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => {
          void server.stop()
          resolve()
        })
      })
    )
  }

  for (const loop of loopsFor(role, parts)) {
    logger.info("loop", { name: loop.name, intervalMs: loop.interval })
    running.push(
      runLoop({
        name: loop.name,
        intervalMs: loop.interval,
        tick: loop.tick,
        signal: controller.signal,
        onError: (error, consecutive) =>
          logger.error("loop-failed", {
            name: loop.name,
            consecutive,
            message: (error as Error).message,
          }),
      })
    )
  }

  await Promise.all(running)
  await close()
  logger.info("stopped", { role })
}
