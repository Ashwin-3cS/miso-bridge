import { evmChain, type EvmChain } from "@misofm/cctp-forwarders/evm-forwarder"

/**
 * JSON-RPC against an EVM source chain, with the chain-id guard.
 *
 * The guard is not optional. Circle's TokenMessengerV2 sits at the same
 * address on Avalanche and Polygon, and a recipient's deposit address is the
 * same on every chain, so a misconfigured endpoint would read plausible
 * nonsense -- balances and logs from the wrong chain -- rather than fail. It
 * is checked once per client and again by the sibling repo's burn discovery on
 * every call.
 *
 * Balances are read as a JSON-RPC batch of `eth_call`s rather than through a
 * multicall contract: each result is a single word, so there is no nested ABI
 * decoding to hand-roll, and there is no extra deployed address to trust.
 */

const BALANCE_OF = "0x70a08231"

/** The shape the sibling repo's discovery functions expect. */
export type JsonRpc = {
  request(args: { method: string; params: unknown[] }): Promise<unknown>
}

export type EvmRpc = JsonRpc & {
  readonly chain: EvmChain
  /** Resolves once the endpoint has proved it is this chain; cached. */
  assertChain(): Promise<void>
  balancesOf(args: {
    token: string
    holders: readonly string[]
  }): Promise<bigint[]>
  hasCode(address: string): Promise<boolean>
  /** The highest block that cannot be reorged away. */
  finalizedBlockNumber(): Promise<bigint>
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly method: string
  ) {
    super(message)
    this.name = "RpcError"
  }
}

export class WrongChain extends Error {
  constructor(expected: number, got: string) {
    super(`RPC reports chain id ${got}, expected ${expected}`)
    this.name = "WrongChain"
  }
}

type Call = { method: string; params: unknown[] }

const word = (value: string) => {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`not hex: ${value}`)
  return value === "0x" ? 0n : BigInt(value)
}

const padded = (address: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new Error(`not an address: ${address}`)
  return address.slice(2).toLowerCase().padStart(64, "0")
}

export function createEvmRpc(options: {
  url: string
  chain: EvmChain
  fetchFn?: typeof fetch
  /** Addresses per batched request; keeps a single body a sane size. */
  batchSize?: number
}): EvmRpc {
  const { url, chain } = options
  const fetchFn = options.fetchFn ?? fetch
  const batchSize = options.batchSize ?? 100
  const expected = evmChain(chain).chainId
  let verified: Promise<void> | null = null

  async function send(calls: readonly Call[]): Promise<unknown[]> {
    if (calls.length === 0) return []
    const body = calls.map((call, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: call.method,
      params: call.params,
    }))
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(calls.length === 1 ? body[0] : body),
    })
    if (!response.ok)
      throw new RpcError(`HTTP ${response.status}`, calls[0]?.method ?? "batch")
    const payload = (await response.json()) as unknown
    const entries = Array.isArray(payload) ? payload : [payload]
    if (entries.length !== calls.length)
      throw new RpcError(
        `expected ${calls.length} results, got ${entries.length}`,
        calls[0]?.method ?? "batch"
      )
    // A batch may come back in any order; ids put it straight again.
    const byId = new Map<
      number,
      { result?: unknown; error?: { message?: string } }
    >()
    for (const entry of entries) {
      const row = entry as {
        id?: unknown
        result?: unknown
        error?: { message?: string }
      }
      if (typeof row.id !== "number")
        throw new RpcError("response without a numeric id", "batch")
      byId.set(row.id, row)
    }
    return calls.map((call, index) => {
      const row = byId.get(index)
      if (row === undefined)
        throw new RpcError(`no result for id ${index}`, call.method)
      if (row.error !== undefined)
        throw new RpcError(row.error.message ?? "RPC error", call.method)
      return row.result
    })
  }

  const rpc: EvmRpc = {
    chain,

    async request(args) {
      // eth_chainId must not recurse through the guard.
      if (args.method !== "eth_chainId") await rpc.assertChain()
      const [result] = await send([
        { method: args.method, params: args.params },
      ])
      return result
    },

    assertChain() {
      verified ??= (async () => {
        const [result] = await send([{ method: "eth_chainId", params: [] }])
        if (typeof result !== "string" || BigInt(result) !== BigInt(expected)) {
          // Do not cache a failure: a corrected endpoint should work on retry.
          verified = null
          throw new WrongChain(expected, String(result))
        }
      })()
      return verified
    },

    async balancesOf({ token, holders }) {
      await rpc.assertChain()
      const data = holders.map((holder) => ({
        method: "eth_call",
        params: [{ to: token, data: BALANCE_OF + padded(holder) }, "latest"],
      }))
      const out: bigint[] = []
      for (let i = 0; i < data.length; i += batchSize) {
        const results = await send(data.slice(i, i + batchSize))
        for (const result of results) {
          if (typeof result !== "string")
            throw new RpcError("eth_call returned a non-string", "eth_call")
          out.push(word(result))
        }
      }
      return out
    },

    async hasCode(address) {
      await rpc.assertChain()
      const [result] = await send([
        { method: "eth_getCode", params: [address, "latest"] },
      ])
      if (typeof result !== "string")
        throw new RpcError("eth_getCode returned a non-string", "eth_getCode")
      return result.length > 2
    },

    async finalizedBlockNumber() {
      await rpc.assertChain()
      const [result] = await send([
        { method: "eth_getBlockByNumber", params: ["finalized", false] },
      ])
      const block = result as { number?: unknown } | null
      if (block === null || typeof block.number !== "string")
        throw new RpcError(
          "no finalized block; the endpoint may not support the tag",
          "eth_getBlockByNumber"
        )
      return word(block.number)
    },
  }

  return rpc
}
