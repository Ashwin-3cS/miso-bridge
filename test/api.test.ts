import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { authorize } from "../src/api/auth.js"
import { createRouter } from "../src/api/routes.js"
import { publicPhase } from "../src/api/status.js"
import { loadConfig, Secret, type Config } from "../src/config.js"
import { disclosure } from "../src/disclosure.js"
import { type Db } from "../src/db.js"
import { depositAddress } from "../src/forwarder.js"
import {
  openJournal,
  type BurnRow,
  type DepositRow,
  type Journal,
} from "../src/journal.js"
import { formatUsdc } from "../src/usdc.js"
import { openIsolatedDb, truncateAll } from "./helpers/db.js"

const url = process.env.DATABASE_URL
const SUI = "0x7a1d4e3b9c5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f708"
const SECRET = "shared-secret"

const env = (network: "mainnet" | "testnet") => ({
  NETWORK: network,
  DATABASE_URL: url ?? "postgres://unused",
  AVALANCHE_RPC_URL: "https://api.avax.network/ext/bc/C/rpc",
  POLYGON_RPC_URL: "https://polygon-rpc.com",
  SUI_RPC_URL: "https://fullnode.mainnet.sui.io",
  API_SHARED_SECRET: SECRET,
})

describe("formatUsdc", () => {
  it.each([
    [0n, "0.000000"],
    [1n, "0.000001"],
    [1_000_000n, "1.000000"],
    [12_345_678n, "12.345678"],
    [10_000_000_000_000n, "10000000.000000"],
  ])("formats %s", (units, text) => {
    expect(formatUsdc(units)).toBe(text)
  })
})

describe("authorize", () => {
  const request = (header?: string) =>
    new Request("https://bridge.test/v1/x", {
      headers: header === undefined ? {} : { authorization: header },
    })

  it("is open when no secret is configured", () => {
    expect(authorize(request(), undefined)).toBe(true)
  })

  it.each([
    ["no header", undefined],
    ["the wrong scheme", `Basic ${SECRET}`],
    ["no token", "Bearer"],
    ["the wrong token", "Bearer nope"],
    // A shorter or longer token must be rejected, not throw: timingSafeEqual
    // requires equal lengths, which is why the compare is over digests.
    ["a short token", "Bearer s"],
    ["a long token", `Bearer ${SECRET}${SECRET}`],
  ])("rejects %s", (_label, header) => {
    expect(authorize(request(header), new Secret(SECRET))).toBe(false)
  })

  it("accepts the token, in any header case", () => {
    expect(authorize(request(`Bearer ${SECRET}`), new Secret(SECRET))).toBe(
      true
    )
    expect(authorize(request(`bearer ${SECRET}`), new Secret(SECRET))).toBe(
      true
    )
  })
})

describe("the disclosure", () => {
  const text = disclosure(["avalanche", "polygon"])

  it.each([
    ["both networks", "Avalanche or Polygon"],
    ["both gas tokens", "AVAX or POL"],
    ["that funds may be stuck permanently", "may stay there"],
    ["that nobody can move the funds", "including Miso"],
    ["that the address is single-use", "this top-up only"],
    ["bridged USDC.e", "USDC.e"],
    ["the post-burn deny-list case", "blocked by Circle on Sui"],
  ])("states %s", (_label, phrase) => {
    expect(text).toContain(phrase)
  })

  it("names one network when only one chain is supported", () => {
    expect(disclosure(["avalanche"])).toContain("native USDC on Avalanche, and")
  })
})

describe("publicPhase", () => {
  const deposit = (status: DepositRow["status"]): DepositRow => ({
    id: "1",
    suiAddress: SUI,
    network: "mainnet",
    chain: "avalanche",
    forwarderAddress: "0x" + "1".repeat(40),
    status,
    waitingReason: status === "waiting" ? "circle: paused" : null,
    lastBalance: 0n,
    lastBalanceAt: null,
    hotUntil: null,
    crankAttempts: 0,
  })
  const burn = (status: BurnRow["status"]): BurnRow => ({
    id: "1",
    depositId: "1",
    network: "mainnet",
    chain: "avalanche",
    txHash: "0x" + "2".repeat(64),
    burnIndex: 0,
    blockNumber: 1n,
    amount: 1_000_000n,
    status,
    nonce: null,
    message: null,
    attestation: null,
    maxFee: null,
    feeExecuted: null,
    problem: status === "quarantined" ? "mismatch" : null,
    delayReason: null,
  })

  it.each([
    ["issued", [], "awaiting_deposit"],
    ["fundable", [], "deposit_seen"],
    ["cranking", [], "deposit_seen"],
    ["waiting", [], "waiting_on_circle"],
    ["cranked", ["discovered"], "attesting"],
    ["cranked", ["attesting"], "attesting"],
    ["cranked", ["validated"], "delivering"],
    ["cranked", ["minting"], "delivering"],
    ["cranked", ["minted"], "delivered"],
    ["cranked", ["reconciled"], "delivered"],
    ["cranked", ["quarantined"], "needs_attention"],
  ] as const)("deposit %s with burns %j is %s", (status, burns, phase) => {
    expect(
      publicPhase({
        deposit: deposit(status),
        burns: burns.map((s) => burn(s)),
      }).phase
    ).toBe(phase)
  })

  it("a quarantined burn dominates a delivered one", () => {
    expect(
      publicPhase({
        deposit: deposit("cranked"),
        burns: [burn("minted"), burn("quarantined")],
      }).phase
    ).toBe("needs_attention")
  })

  it("an in-flight burn dominates a new deposit at the same address", () => {
    expect(
      publicPhase({ deposit: deposit("fundable"), burns: [burn("validated")] })
        .phase
    ).toBe("delivering")
  })

  it("never tells a user that waiting on Circle is a failure", () => {
    const { detail } = publicPhase({ deposit: deposit("waiting"), burns: [] })
    expect(detail).toContain("stays where it is")
    expect(detail.toLowerCase()).not.toMatch(/fail|error|lost/)
  })
})

describe.skipIf(!url)("the API", () => {
  let db: Db
  let journal: Journal
  let config: Config
  let handle: (request: Request) => Promise<Response>

  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }
  ) =>
    handle(
      new Request(`https://bridge.test${path}`, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    )

  beforeAll(async () => {
    config = loadConfig({ ...env("mainnet"), DATABASE_URL: url as string })
    db = await openIsolatedDb(url as string, "api_test")
    journal = openJournal(db, "mainnet")
    handle = createRouter({ config, db, journal })
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const issue = () =>
    call("POST", "/v1/deposit-addresses", {
      suiAddress: SUI,
      userRef: "user-1",
    })

  describe("issuing an address", () => {
    it("derives the address and states the terms", async () => {
      const response = await issue()
      expect(response.status).toBe(201)
      const body = (await response.json()) as Record<string, unknown>
      expect(body.depositAddress).toBe(depositAddress("mainnet", SUI))
      expect(body.chains).toEqual(["avalanche", "polygon"])
      expect(body.minimumUsdc).toBe("1.000000")
      expect(body.disclosure).toContain("including Miso")
      expect(body.denyListChecked).toBe(false)
      expect((body.deposits as unknown[]).length).toBe(2)
    })

    it("is idempotent, returning the same deposits", async () => {
      const first = (await (await issue()).json()) as {
        deposits: Array<{ id: string }>
      }
      const second = (await (await issue()).json()) as {
        deposits: Array<{ id: string }>
      }
      expect(second.deposits.map((d) => d.id)).toEqual(
        first.deposits.map((d) => d.id)
      )
      expect((await db.query("select 1 from deposits")).length).toBe(2)
    })

    it("gives both chains the same address", async () => {
      const body = (await (await issue()).json()) as {
        depositAddress: string
        deposits: Array<{ depositAddress: string }>
      }
      for (const deposit of body.deposits)
        expect(deposit.depositAddress).toBe(body.depositAddress.toLowerCase())
    })

    it.each([
      ["a malformed recipient", { suiAddress: "0xdeadbeef", userRef: "u" }],
      ["an EVM address", { suiAddress: "0x" + "1".repeat(40), userRef: "u" }],
      ["no userRef", { suiAddress: SUI }],
      ["an empty userRef", { suiAddress: SUI, userRef: "" }],
      ["no recipient", { userRef: "u" }],
    ])("rejects %s", async (_label, body) => {
      expect((await call("POST", "/v1/deposit-addresses", body)).status).toBe(
        400
      )
    })

    it("rejects the zero recipient Circle would refuse", async () => {
      const response = await call("POST", "/v1/deposit-addresses", {
        suiAddress: "0x" + "0".repeat(64),
        userRef: "u",
      })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toContain(
        "non-zero"
      )
    })

    it("refuses a recipient known to be deny-listed on Sui", async () => {
      await journal.bindRecipient({ suiAddress: SUI, userRef: "user-1" })
      await journal.recordDenyCheck(SUI, true)
      const response = await issue()
      expect(response.status).toBe(409)
      expect((await db.query("select 1 from deposits")).length).toBe(0)
    })

    it("reports a checked, clean recipient as checked", async () => {
      await journal.bindRecipient({ suiAddress: SUI, userRef: "user-1" })
      await journal.recordDenyCheck(SUI, false)
      const body = (await (await issue()).json()) as {
        denyListChecked: boolean
      }
      expect(body.denyListChecked).toBe(true)
    })

    it("marks the address hot so the watcher polls it", async () => {
      await issue()
      const hot = await journal.hotDeposits({ chain: "avalanche", limit: 10 })
      expect(hot.length).toBe(1)
    })
  })

  describe("reading state", () => {
    it("returns an address and its deposits", async () => {
      await issue()
      const response = await call("GET", `/v1/deposit-addresses/${SUI}`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        deposits: Array<{ phase: string }>
      }
      expect(body.deposits.map((d) => d.phase)).toEqual([
        "awaiting_deposit",
        "awaiting_deposit",
      ])
    })

    it("404s an address that was never issued", async () => {
      expect((await call("GET", `/v1/deposit-addresses/${SUI}`)).status).toBe(
        404
      )
    })

    it("400s a malformed address", async () => {
      expect((await call("GET", "/v1/deposit-addresses/nope")).status).toBe(400)
    })

    it("returns one deposit with its transfers", async () => {
      const body = (await (await issue()).json()) as {
        deposits: Array<{ id: string }>
      }
      const id = body.deposits[0]?.id as string
      const response = await call("GET", `/v1/deposits/${id}`)
      expect(response.status).toBe(200)
      const deposit = (await response.json()) as Record<string, unknown>
      expect(deposit.phase).toBe("awaiting_deposit")
      expect(deposit.balance).toBe("0.000000")
      expect(deposit.transfers).toEqual([])
    })

    it.each([["999999"], ["not-a-number"]])("404s deposit %s", async (id) => {
      expect((await call("GET", `/v1/deposits/${id}`)).status).toBe(404)
    })
  })

  describe("the crank nudge", () => {
    it("queues without submitting anything", async () => {
      const body = (await (await issue()).json()) as {
        deposits: Array<{ id: string }>
      }
      const id = body.deposits[0]?.id as string
      const response = await call("POST", `/v1/deposits/${id}/crank`)
      expect(response.status).toBe(202)
      // A nudge must not change the deposit's state; only the crank worker does.
      const deposit = await journal.depositById(id)
      expect(deposit?.status).toBe("issued")
      expect(deposit?.crankAttempts).toBe(0)
    })

    it("404s an unknown deposit", async () => {
      expect((await call("POST", "/v1/deposits/4242/crank")).status).toBe(404)
    })
  })

  describe("auth and operational routes", () => {
    it("needs the bearer token on every /v1 route", async () => {
      for (const [method, path] of [
        ["POST", "/v1/deposit-addresses"],
        ["GET", `/v1/deposit-addresses/${SUI}`],
        ["GET", "/v1/deposits/1"],
        ["POST", "/v1/deposits/1/crank"],
        ["GET", "/metrics"],
      ] as const)
        expect((await call(method, path, undefined, {})).status).toBe(401)
    })

    it("leaves liveness open", async () => {
      expect((await call("GET", "/healthz", undefined, {})).status).toBe(200)
    })

    it("reports readiness from the database", async () => {
      const response = await call("GET", "/readyz", undefined, {})
      expect(response.status).toBe(200)
      expect((await response.json()) as { database: boolean }).toEqual({
        ok: true,
        database: true,
      })
    })

    it("exposes counts as metrics", async () => {
      await issue()
      const response = await call("GET", "/metrics")
      const text = await response.text()
      expect(text).toContain(
        'bridge_deposits{network="mainnet",status="issued"} 2'
      )
    })

    it("404s an unknown route", async () => {
      expect((await call("GET", "/v1/nope")).status).toBe(404)
      expect((await call("GET", "/nope", undefined, {})).status).toBe(404)
    })
  })

  describe("on a network with no forwarder build", () => {
    it("refuses to issue an address rather than invent one", async () => {
      const testnet = createRouter({
        config: loadConfig({ ...env("testnet"), DATABASE_URL: url as string }),
        db,
        journal: openJournal(db, "testnet"),
      })
      const response = await testnet(
        new Request("https://bridge.test/v1/deposit-addresses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ suiAddress: SUI, userRef: "user-1" }),
        })
      )
      expect(response.status).toBe(503)
      expect(((await response.json()) as { error: string }).error).toContain(
        "no forwarder build for testnet"
      )
      expect((await db.query("select 1 from deposits")).length).toBe(0)
    })
  })
})
