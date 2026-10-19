import { describe, expect, it } from "vitest"
import { createEvmRpc, RpcError, WrongChain } from "../src/chain/evm.js"

/**
 * The client against a scripted endpoint. Nothing here touches the network:
 * fetch is injected, which is also how the sibling repo's modules are tested.
 */

const AVALANCHE = 43114
const USDC = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"
const HOLDER = "0xA199fdabB9F87D4a2AEE095cA95cEE3abf70F6Ff"

type Handler = (
  calls: Array<{ id: number; method: string; params: unknown[] }>
) => unknown

function endpoint(handler: Handler) {
  const bodies: unknown[] = []
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    const calls = Array.isArray(body) ? body : [body]
    const payload = handler(calls)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetchFn, bodies }
}

const ok = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result })

const chainIdOnly = (id: number) => ok(id, "0x" + AVALANCHE.toString(16))

function client(handler: Handler, batchSize?: number) {
  const { fetchFn, bodies } = endpoint(handler)
  return {
    rpc: createEvmRpc({
      url: "https://rpc.test",
      chain: "avalanche",
      fetchFn,
      batchSize,
    }),
    bodies,
  }
}

describe("the chain-id guard", () => {
  it("accepts the expected chain and checks it once", async () => {
    const seen: string[] = []
    const { rpc } = client((calls) =>
      calls.map((call) => {
        seen.push(call.method)
        return call.method === "eth_chainId"
          ? chainIdOnly(call.id)
          : ok(call.id, "0x0")
      })
    )
    await rpc.assertChain()
    await rpc.assertChain()
    await rpc.hasCode(HOLDER)
    expect(seen.filter((m) => m === "eth_chainId").length).toBe(1)
  })

  it("refuses an endpoint for the other chain", async () => {
    // Polygon's id, from a client configured for Avalanche. Circle's messenger
    // and every deposit address are at the same addresses on both, so this
    // must fail rather than read plausible nonsense.
    const { rpc } = client((calls) => calls.map((call) => ok(call.id, "0x89")))
    await expect(rpc.assertChain()).rejects.toThrow(WrongChain)
    await expect(
      rpc.balancesOf({ token: USDC, holders: [HOLDER] })
    ).rejects.toThrow("expected 43114")
  })

  it("does not cache a failure, so a corrected endpoint recovers", async () => {
    let wrong = true
    const { rpc } = client((calls) =>
      calls.map((call) =>
        call.method === "eth_chainId"
          ? ok(call.id, wrong ? "0x89" : "0xa86a")
          : ok(call.id, "0x1")
      )
    )
    await expect(rpc.assertChain()).rejects.toThrow(WrongChain)
    wrong = false
    await expect(rpc.assertChain()).resolves.toBeUndefined()
  })

  it("guards every call, including a raw request", async () => {
    const methods: string[] = []
    const { rpc } = client((calls) =>
      calls.map((call) => {
        methods.push(call.method)
        return call.method === "eth_chainId"
          ? chainIdOnly(call.id)
          : ok(call.id, [])
      })
    )
    await rpc.request({ method: "eth_getLogs", params: [{}] })
    expect(methods).toEqual(["eth_chainId", "eth_getLogs"])
  })
})

describe("balances", () => {
  const balanceEndpoint = (balances: Record<string, string>) =>
    client((calls) =>
      calls.map((call) => {
        if (call.method === "eth_chainId") return chainIdOnly(call.id)
        const [{ data }] = call.params as [{ data: string }]
        const holder = "0x" + data.slice(-40)
        return ok(call.id, balances[holder.toLowerCase()] ?? "0x0")
      })
    )

  it("reads one balance per holder, in order", async () => {
    const { rpc } = balanceEndpoint({
      [HOLDER.toLowerCase()]: "0x" + 7_000_000n.toString(16),
      ["0x" + "1".repeat(40)]: "0x" + 1n.toString(16),
    })
    expect(
      await rpc.balancesOf({
        token: USDC,
        holders: [HOLDER, "0x" + "1".repeat(40)],
      })
    ).toEqual([7_000_000n, 1n])
  })

  it("reads an empty result as zero, not an error", async () => {
    const { rpc } = client((calls) =>
      calls.map((call) =>
        call.method === "eth_chainId" ? chainIdOnly(call.id) : ok(call.id, "0x")
      )
    )
    expect(await rpc.balancesOf({ token: USDC, holders: [HOLDER] })).toEqual([
      0n,
    ])
  })

  it("chunks the batch and sends one request per chunk", async () => {
    const holders = Array.from(
      { length: 7 },
      (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0")
    )
    const { rpc, bodies } = client(
      (calls) =>
        calls.map((call) =>
          call.method === "eth_chainId"
            ? chainIdOnly(call.id)
            : ok(call.id, "0x0")
        ),
      3
    )
    await rpc.balancesOf({ token: USDC, holders })
    // The chain-id call, then ceil(7/3) chunks. The trailing chunk of one goes
    // as a single object rather than a one-element array.
    const sizes = bodies
      .slice(1)
      .map((body) => (Array.isArray(body) ? body.length : 1))
    expect(sizes).toEqual([3, 3, 1])
    expect(Array.isArray(bodies[bodies.length - 1])).toBe(false)
  })

  it("puts an out-of-order batch straight again by id", async () => {
    const holders = ["0x" + "1".repeat(40), "0x" + "2".repeat(40)]
    const { rpc } = client((calls) => {
      if (calls[0]?.method === "eth_chainId") return chainIdOnly(calls[0].id)
      // Reversed, with distinct values, so a positional read would swap them.
      return calls
        .map((call) => ok(call.id, call.id === 0 ? "0x1" : "0x2"))
        .reverse()
    })
    expect(await rpc.balancesOf({ token: USDC, holders })).toEqual([1n, 2n])
  })

  it("sends a single call as an object, not a one-element array", async () => {
    const { rpc, bodies } = balanceEndpoint({})
    await rpc.balancesOf({ token: USDC, holders: [HOLDER] })
    expect(Array.isArray(bodies[0])).toBe(false)
  })

  it("rejects a malformed holder before calling out", async () => {
    const { rpc, bodies } = balanceEndpoint({})
    await rpc.assertChain()
    bodies.length = 0
    await expect(
      rpc.balancesOf({ token: USDC, holders: ["not-an-address"] })
    ).rejects.toThrow("not an address")
    expect(bodies).toEqual([])
  })
})

describe("failures", () => {
  it("surfaces an RPC error with its method", async () => {
    const { rpc } = client((calls) =>
      calls.map((call) =>
        call.method === "eth_chainId"
          ? chainIdOnly(call.id)
          : { jsonrpc: "2.0", id: call.id, error: { message: "rate limited" } }
      )
    )
    await expect(rpc.hasCode(HOLDER)).rejects.toThrow("rate limited")
  })

  it("surfaces a non-200 as an error", async () => {
    const fetchFn = (async () =>
      new Response("gateway", { status: 502 })) as unknown as typeof fetch
    const rpc = createEvmRpc({
      url: "https://rpc.test",
      chain: "avalanche",
      fetchFn,
    })
    await expect(rpc.assertChain()).rejects.toThrow("HTTP 502")
  })

  it("refuses a batch that comes back the wrong size", async () => {
    const { rpc } = client((calls) =>
      calls[0]?.method === "eth_chainId" ? chainIdOnly(calls[0].id) : []
    )
    await expect(
      rpc.balancesOf({ token: USDC, holders: [HOLDER, HOLDER] })
    ).rejects.toThrow(RpcError)
  })

  it("says so when the endpoint has no finalized tag", async () => {
    const { rpc } = client((calls) =>
      calls.map((call) =>
        call.method === "eth_chainId" ? chainIdOnly(call.id) : ok(call.id, null)
      )
    )
    await expect(rpc.finalizedBlockNumber()).rejects.toThrow(
      "no finalized block"
    )
  })
})

describe("reads used by the workers", () => {
  it("reports code at a deployed deposit address", async () => {
    const { rpc } = client((calls) =>
      calls.map((call) =>
        call.method === "eth_chainId"
          ? chainIdOnly(call.id)
          : ok(call.id, "0x363d3d37")
      )
    )
    expect(await rpc.hasCode(HOLDER)).toBe(true)
  })

  it("reports no code at an address that has never been cranked", async () => {
    const { rpc } = client((calls) =>
      calls.map((call) =>
        call.method === "eth_chainId" ? chainIdOnly(call.id) : ok(call.id, "0x")
      )
    )
    expect(await rpc.hasCode(HOLDER)).toBe(false)
  })

  it("reads the finalized block number", async () => {
    const { rpc } = client((calls) =>
      calls.map((call) =>
        call.method === "eth_chainId"
          ? chainIdOnly(call.id)
          : ok(call.id, { number: "0x1e8480" })
      )
    )
    expect(await rpc.finalizedBlockNumber()).toBe(2_000_000n)
  })
})
