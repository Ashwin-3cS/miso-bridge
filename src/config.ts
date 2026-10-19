import { z } from "zod"

/**
 * The service's configuration, validated once at boot. Every worker and
 * route reads it from here; nothing reads `process.env` directly.
 *
 * Secrets are wrapped in `Secret`, which has no useful `toString`, so a key
 * cannot reach a log line, an error message or the journal by accident.
 */

/** A value that must never be printed. Read it with `.reveal()`. */
export class Secret {
  #value: string
  constructor(value: string) {
    this.#value = value
  }
  reveal(): string {
    return this.#value
  }
  toString(): string {
    return "[redacted]"
  }
  toJSON(): string {
    return "[redacted]"
  }
  get [Symbol.toStringTag](): string {
    return "Secret"
  }
}

const secret = z
  .string()
  .min(1)
  .transform((v) => new Secret(v))

const httpUrl = z
  .string()
  .url()
  .refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
    message: "must be an http(s) URL",
  })

/** USDC has six decimals; config is written in USDC, held as base units. */
const usdc = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, "amount in USDC with up to 6 decimals")
  .transform((v) => {
    const [whole = "0", fraction = ""] = v.split(".")
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0")
  })

const seconds = z.coerce.number().int().positive()

/**
 * Mainnet and testnet are different forwarder builds with different deposit
 * addresses, so the network is configuration, never inferred from an RPC. It
 * is also stamped on every alert: a stalled testnet burn is expected (Circle's
 * sandbox does not attest Sui-bound messages) and must not page anyone.
 */
export const networks = ["mainnet", "testnet"] as const
export type Network = (typeof networks)[number]

const schema = z.object({
  NETWORK: z.enum(networks),
  DATABASE_URL: secret,

  AVALANCHE_RPC_URL: httpUrl,
  AVALANCHE_RPC_FALLBACK_URL: httpUrl.optional(),
  POLYGON_RPC_URL: httpUrl,
  POLYGON_RPC_FALLBACK_URL: httpUrl.optional(),
  SUI_RPC_URL: httpUrl,

  // Gas-only signers. Absent is legitimate: a read-only staging run, or a
  // process running only the API or the discovery workers.
  AVALANCHE_CRANK_KEY: secret.optional(),
  POLYGON_CRANK_KEY: secret.optional(),
  SUI_MINT_KEY: secret.optional(),

  IRIS_BASE_URL: httpUrl.default("https://iris-api.circle.com"),

  /** Below this, a crank costs more gas than it moves. */
  CRANK_FLOOR_USDC: usdc.prefault("1"),
  /** Cranks per address per day, so a griefer cannot drain the gas wallet. */
  CRANK_BUDGET_PER_DEPOSIT: z.coerce.number().int().positive().default(24),

  CRANK_DEADLINE_SECONDS: seconds.default(600),
  ATTEST_DEADLINE_SECONDS: seconds.default(1800),
  MINT_DEADLINE_SECONDS: seconds.default(1800),

  AVALANCHE_MAX_FEE_GWEI: z.coerce.number().positive().default(100),
  POLYGON_MAX_FEE_GWEI: z.coerce.number().positive().default(500),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  API_SHARED_SECRET: secret.optional(),
  ALERT_WEBHOOK_URL: httpUrl.optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
})

export type Config = Readonly<z.infer<typeof schema>>

/**
 * Parses and freezes the environment, throwing one error that names every
 * problem at once. Never logs a value: a rejected secret would otherwise be
 * printed by the error itself.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env)
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    throw new Error(`invalid configuration:\n${problems}`)
  }
  if (result.data.NETWORK === "mainnet" && !result.data.API_SHARED_SECRET)
    throw new Error(
      "invalid configuration:\n  API_SHARED_SECRET: required on mainnet"
    )
  return Object.freeze(result.data)
}

/**
 * A JSON-safe, secret-free view of the configuration, for the boot log.
 *
 * `JSON.stringify(config)` throws: amounts are bigints. Logging the config
 * directly is therefore both a crash and a leak, so this is the only
 * supported way to print it.
 *
 * It enumerates the schema rather than the parsed object, so an unset
 * optional — a missing crank key, say — shows up as "(unset)" instead of
 * vanishing from the boot log.
 */
export function describeConfig(
  config: Config
): Readonly<Record<string, string>> {
  const entries = Object.keys(schema.shape).map((key) => {
    const value = config[key as keyof Config]
    if (value === undefined) return [key, "(unset)"] as const
    return [
      key,
      value instanceof Secret ? "[redacted]" : String(value),
    ] as const
  })
  return Object.freeze(Object.fromEntries(entries))
}
