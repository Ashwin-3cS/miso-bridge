import { z } from "zod"
import type { Config } from "../config.js"
import type { Db } from "../db.js"
import { disclosure } from "../disclosure.js"
import {
  chainsFor,
  depositAddress,
  NoForwarderBuild,
  type EvmChain,
} from "../forwarder.js"
import type { BurnRow, DepositRow, Journal } from "../journal.js"
import { formatUsdc } from "../usdc.js"
import { authorize } from "./auth.js"
import { publicPhase } from "./status.js"

/**
 * The HTTP surface the app consumes.
 *
 * A pure `Request -> Response` function, so the whole API is testable without
 * binding a port. No route can move USDC, because the service has no such
 * code path: issuing an address derives it, and a crank nudge only marks an
 * address worth watching.
 */

export type RouterDeps = {
  config: Config
  db: Db
  journal: Journal
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const fail = (status: number, error: string) => json(status, { error })

const issueBody = z.object({
  suiAddress: z.string(),
  /**
   * The app's identifier for the authenticated user. Recorded so an address
   * can always be traced back to the account it was bound to.
   */
  userRef: z.string().min(1).max(200),
})

const suiAddressPattern = /^0x[0-9a-fA-F]{64}$/

function describeTransfers(burns: readonly BurnRow[]) {
  return burns.map((burn) => ({
    txHash: burn.txHash,
    amount: formatUsdc(burn.amount),
    status: burn.status,
    nonce: burn.nonce,
    feeExecuted:
      burn.feeExecuted === null ? null : formatUsdc(burn.feeExecuted),
  }))
}

export function createRouter(
  deps: RouterDeps
): (request: Request) => Promise<Response> {
  const { config, db, journal } = deps

  async function describeDeposit(deposit: DepositRow) {
    const burns = await journal.burnsForDeposit(deposit.id)
    const { phase, detail } = publicPhase({ deposit, burns })
    return {
      id: deposit.id,
      chain: deposit.chain,
      depositAddress: deposit.forwarderAddress,
      phase,
      detail,
      balance: formatUsdc(deposit.lastBalance),
      transfers: describeTransfers(burns),
    }
  }

  async function issue(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return fail(400, "body must be JSON")
    }
    const parsed = issueBody.safeParse(body)
    if (!parsed.success)
      return fail(
        400,
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")
      )
    const { suiAddress, userRef } = parsed.data
    if (!suiAddressPattern.test(suiAddress))
      return fail(400, "suiAddress must be 0x and 32 bytes of hex")

    let address: string
    let chains: readonly EvmChain[]
    try {
      address = depositAddress(config.NETWORK, suiAddress)
      chains = chainsFor(config.NETWORK)
    } catch (error) {
      if (error instanceof NoForwarderBuild)
        return fail(503, (error as Error).message)
      return fail(400, (error as Error).message)
    }

    // The recipient is bound before any address exists for it. Sui does not
    // validate a mint recipient, so this binding is the only thing between a
    // user and a mint into an address nobody controls.
    await journal.bindRecipient({ suiAddress, userRef })

    const denyListed = await journal.recipientDenyListed(suiAddress)
    if (denyListed === true)
      return fail(409, "this Sui account is on Circle's USDC deny list on Sui")

    const deposits = []
    for (const chain of chains) {
      const deposit = await journal.issueDeposit({
        suiAddress,
        chain,
        forwarderAddress: address,
      })
      await journal.markHot(deposit.id, config.HOT_WINDOW_SECONDS)
      deposits.push(await describeDeposit(deposit))
    }

    return json(201, {
      network: config.NETWORK,
      suiAddress: suiAddress.toLowerCase(),
      depositAddress: address,
      chains,
      minimumUsdc: formatUsdc(config.CRANK_FLOOR_USDC),
      // False until a Sui deny-list read has actually been made for this
      // recipient; the caller should not present it as checked when it is not.
      denyListChecked: denyListed !== null,
      disclosure: disclosure(chains),
      deposits,
    })
  }

  async function readAddresses(suiAddress: string): Promise<Response> {
    if (!suiAddressPattern.test(suiAddress))
      return fail(400, "suiAddress must be 0x and 32 bytes of hex")
    const deposits = await journal.depositsFor(suiAddress)
    if (deposits.length === 0) return fail(404, "no address has been issued")
    return json(200, {
      network: config.NETWORK,
      suiAddress: suiAddress.toLowerCase(),
      depositAddress: deposits[0]?.forwarderAddress,
      deposits: await Promise.all(deposits.map(describeDeposit)),
    })
  }

  async function readDeposit(id: string): Promise<Response> {
    const deposit = await journal.depositById(id)
    if (deposit === null) return fail(404, "no such deposit")
    return json(200, {
      network: config.NETWORK,
      suiAddress: deposit.suiAddress,
      ...(await describeDeposit(deposit)),
    })
  }

  /**
   * A nudge, not a crank. It marks the address worth polling now; the crank
   * worker is the only thing that submits a transaction, and it chooses
   * nothing about the outcome.
   */
  async function nudge(id: string): Promise<Response> {
    const deposit = await journal.depositById(id)
    if (deposit === null) return fail(404, "no such deposit")
    await journal.markHot(deposit.id, config.HOT_WINDOW_SECONDS)
    return json(202, { queued: true, id: deposit.id })
  }

  async function metrics(): Promise<Response> {
    const counts = await journal.counts()
    const lines = [
      "# HELP bridge_deposits Deposit addresses by status.",
      "# TYPE bridge_deposits gauge",
      ...Object.entries(counts.deposits).map(
        ([status, n]) =>
          `bridge_deposits{network="${config.NETWORK}",status="${status}"} ${n}`
      ),
      "# HELP bridge_burns Forwarder burns by status.",
      "# TYPE bridge_burns gauge",
      ...Object.entries(counts.burns).map(
        ([status, n]) =>
          `bridge_burns{network="${config.NETWORK}",status="${status}"} ${n}`
      ),
    ]
    return new Response(`${lines.join("\n")}\n`, {
      status: 200,
      headers: { "content-type": "text/plain; version=0.0.4" },
    })
  }

  return async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    const method = request.method.toUpperCase()

    if (method === "GET" && pathname === "/healthz")
      return json(200, { ok: true })
    if (method === "GET" && pathname === "/readyz") {
      const ok = await db.healthy()
      return json(ok ? 200 : 503, { ok, database: ok })
    }

    if (!pathname.startsWith("/v1/") && pathname !== "/metrics")
      return fail(404, "no such route")

    if (!authorize(request, config.API_SHARED_SECRET))
      return fail(401, "unauthorized")

    if (method === "GET" && pathname === "/metrics") return metrics()
    if (method === "POST" && pathname === "/v1/deposit-addresses")
      return issue(request)

    const address = /^\/v1\/deposit-addresses\/([^/]+)$/.exec(pathname)
    if (address !== null && method === "GET")
      return readAddresses(decodeURIComponent(address[1] as string))

    const deposit = /^\/v1\/deposits\/([^/]+)$/.exec(pathname)
    if (deposit !== null && method === "GET")
      return readDeposit(deposit[1] as string)

    const crank = /^\/v1\/deposits\/([^/]+)\/crank$/.exec(pathname)
    if (crank !== null && method === "POST") return nudge(crank[1] as string)

    return fail(404, "no such route")
  }
}
