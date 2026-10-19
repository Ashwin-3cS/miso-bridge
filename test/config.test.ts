import { describe, expect, it } from "vitest"
import { describeConfig, loadConfig, Secret } from "../src/config.js"

const base = {
  NETWORK: "testnet",
  DATABASE_URL: "postgres://bridge:bridge@localhost:5433/bridge",
  AVALANCHE_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc",
  POLYGON_RPC_URL: "https://polygon-amoy-bor-rpc.publicnode.com",
  SUI_RPC_URL: "https://fullnode.testnet.sui.io",
}

describe("loadConfig", () => {
  it("names every problem in one error", () => {
    let message = ""
    try {
      loadConfig({ NETWORK: "mars", AVALANCHE_RPC_URL: "not-a-url" })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("NETWORK")
    expect(message).toContain("DATABASE_URL")
    expect(message).toContain("AVALANCHE_RPC_URL")
    expect(message).toContain("SUI_RPC_URL")
  })

  it("applies defaults", () => {
    const config = loadConfig(base)
    expect(config.IRIS_BASE_URL).toBe("https://iris-api.circle.com")
    expect(config.CRANK_FLOOR_USDC).toBe(1_000_000n)
    expect(config.API_PORT).toBe(8080)
  })

  it("reads USDC amounts as base units", () => {
    expect(
      loadConfig({ ...base, CRANK_FLOOR_USDC: "0.5" }).CRANK_FLOOR_USDC
    ).toBe(500_000n)
    expect(
      loadConfig({ ...base, CRANK_FLOOR_USDC: "12.345678" }).CRANK_FLOOR_USDC
    ).toBe(12_345_678n)
    expect(() =>
      loadConfig({ ...base, CRANK_FLOOR_USDC: "0.1234567" })
    ).toThrow()
  })

  it("requires a shared secret on mainnet", () => {
    expect(() => loadConfig({ ...base, NETWORK: "mainnet" })).toThrow(
      "API_SHARED_SECRET"
    )
    const config = loadConfig({
      ...base,
      NETWORK: "mainnet",
      API_SHARED_SECRET: "s3cret",
    })
    expect(config.API_SHARED_SECRET?.reveal()).toBe("s3cret")
  })

  describe("a secret cannot reach a log line", () => {
    const config = loadConfig({ ...base, AVALANCHE_CRANK_KEY: "0xdeadbeef" })
    const key = config.AVALANCHE_CRANK_KEY as Secret

    it("reveals only on request", () => {
      expect(key.reveal()).toBe("0xdeadbeef")
    })

    it.each([
      ["interpolation", `${key}`],
      ["String()", String(key)],
      ["concatenation", "key=" + key],
      ["JSON of the secret", JSON.stringify(key)],
      ["the boot-log view", JSON.stringify(describeConfig(config))],
    ])("redacts under %s", (_label, printed) => {
      expect(printed).not.toContain("deadbeef")
    })

    it("cannot be logged directly: amounts are bigints", () => {
      expect(() => JSON.stringify(config)).toThrow(/BigInt/)
    })

    it("prints every key through the boot-log view", () => {
      const described = describeConfig(config)
      expect(described.CRANK_FLOOR_USDC).toBe("1000000")
      expect(described.AVALANCHE_CRANK_KEY).toBe("[redacted]")
      expect(described.SUI_MINT_KEY).toBe("(unset)")
      expect(described.NETWORK).toBe("testnet")
    })
  })
})
