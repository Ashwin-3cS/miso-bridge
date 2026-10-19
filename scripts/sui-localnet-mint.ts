/**
 * Tier 3b: the mint leg against Circle's real Move code, with our own attester.
 *
 * This is the only way to execute the receive PTB for real without mainnet.
 * Sui testnet verifies Circle's attester set, which cannot be forged, so the
 * localnet from circlefin/sui-cctp is used instead: it publishes Circle's own
 * V2 packages and enrols a known dummy attester at init, so a message can be
 * signed locally and will verify on chain.
 *
 * What this proves: our receive PTB is accepted by Circle's Move code, the
 * nonce flag behaves as the delivery oracle, and the mint worker handles real
 * Move aborts -- a below-threshold finality value and a bad attestation --
 * by preserving the message rather than dropping it.
 *
 * What it does NOT prove, and no amount of localnet can: that Circle's
 * attester will sign a forwarder's burn. That is the mainnet-only leg.
 *
 * Setup (see Circle's README; note setup.sh assumes macOS unless CI=true):
 *
 *   git clone https://github.com/circlefin/sui-cctp
 *   cd sui-cctp && CI=true ./setup.sh v1.76.1
 *   ./run.sh start_network
 *   cd scripts && cp .env.example .env
 *   node .yarn/releases/yarn-3.2.2.cjs install
 *   node .yarn/releases/yarn-3.2.2.cjs deploy-local:v2
 *
 * Then, from this repository:
 *
 *   SUI_CCTP_CONFIG=<path to sui-cctp>/scripts/test_config.v2.env \
 *   DATABASE_URL=postgres://bridge:bridge@localhost:5433/bridge \
 *     bun run scripts/sui-localnet-mint.ts
 */

import { readFileSync } from "node:fs"
import { keccak256, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secret } from "../src/config.js"
import { openSuiMinter, type SuiCctpConfig } from "../src/chain/sui.js"
import { openDb } from "../src/db.js"
import { openJournal } from "../src/journal.js"
import { migrate, readMigrations } from "../src/migrate.js"
import { mintOnce } from "../src/workers/mint.js"

/**
 * Circle's localnet dummy attester, enrolled by their deploy at init. Not a
 * valid attester on any real network.
 */
const ATTESTER_KEY =
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97" as Hex

/** Their localnet registers exactly one remote, domain 0. */
const SOURCE_DOMAIN = 0
/** The same domain real Sui uses, which their constants.ts confirms. */
const SUI_DOMAIN = 8
/** Standard Transfer, as the forwarder emits. */
const MIN_FINALITY_THRESHOLD = 2000
/** Sui's receive path requires at least this; below it the Move code aborts. */
const FINALITY_EXECUTED = 2000
const AMOUNT = 7_000_000n

const RPC_URL = process.env.SUI_LOCALNET_URL ?? "http://localhost:9001"
const FAUCET_URL = process.env.SUI_FAUCET_URL ?? "http://localhost:9123"

let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures += 1
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `  (${detail})`}`
  )
}
const step = (label: string) => console.log(`\n${label}`)

/** Circle's deploy writes a flat KEY=value file. */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match !== null) out[match[1] as string] = (match[2] as string).trim()
  }
  return out
}

const bytes32 = (value: string): Uint8Array => {
  const hex = value.replace(/^0x/, "").toLowerCase().padStart(64, "0")
  if (hex.length !== 64) throw new Error(`not a 32-byte value: ${value}`)
  return Uint8Array.from(Buffer.from(hex, "hex"))
}

/**
 * The recipient an inbound message must target: the keccak256 of the
 * TokenMessengerMinter's authenticator type name. Our pinned mainnet constant
 * is this same derivation against Circle's mainnet package.
 */
function authRecipient(tmmPackageId: string): Uint8Array {
  const padded = tmmPackageId.replace(/^0x/, "").padStart(64, "0")
  const name = `${padded}::message_transmitter_authenticator::MessageTransmitterAuthenticator`
  return bytes32(keccak256(Buffer.from(name, "ascii")))
}

/** A CCTP V2 burn message: 148-byte header, 228-byte body. */
function buildMessage(args: {
  nonce: Uint8Array
  sender: string
  recipient: Uint8Array
  burnToken: string
  mintRecipient: string
  messageSender: string
  amount: bigint
  finalityThresholdExecuted: number
}): Uint8Array {
  const message = new Uint8Array(376)
  const view = new DataView(message.buffer)
  view.setUint32(0, 1) // message version
  view.setUint32(4, SOURCE_DOMAIN)
  view.setUint32(8, SUI_DOMAIN)
  message.set(args.nonce, 12)
  message.set(bytes32(args.sender), 44)
  message.set(args.recipient, 76)
  // destinationCaller 0: anyone may mint, as the forwarder's burns allow.
  view.setUint32(140, MIN_FINALITY_THRESHOLD)
  view.setUint32(144, args.finalityThresholdExecuted)
  view.setUint32(148, 1) // burn body version
  message.set(bytes32(args.burnToken), 152)
  message.set(bytes32(args.mintRecipient), 184)
  message.set(bytes32("0x" + args.amount.toString(16)), 216)
  message.set(bytes32(args.messageSender), 248)
  // maxFee, feeExecuted and expirationBlock stay zero.
  return message
}

/** Circle's verifier expects an ecrecover-style signature over keccak256. */
async function attest(message: Uint8Array): Promise<Uint8Array> {
  const account = privateKeyToAccount(ATTESTER_KEY)
  const signature = await account.sign({ hash: keccak256(message) })
  return Uint8Array.from(Buffer.from(signature.replace(/^0x/, ""), "hex"))
}

async function fundFromFaucet(address: string): Promise<void> {
  const response = await fetch(`${FAUCET_URL}/gas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
  })
  if (!response.ok)
    throw new Error(
      `faucet returned ${response.status}: ${await response.text()}`
    )
}

async function main(): Promise<void> {
  const configPath = process.env.SUI_CCTP_CONFIG
  const databaseUrl = process.env.DATABASE_URL
  if (configPath === undefined) throw new Error("set SUI_CCTP_CONFIG")
  if (databaseUrl === undefined) throw new Error("set DATABASE_URL")

  const env = readEnvFile(configPath)
  const need = (key: string): string => {
    const value = env[key]
    if (value === undefined || value === "")
      throw new Error(`${key} missing from ${configPath}`)
    return value
  }

  const cctp: SuiCctpConfig = {
    messageTransmitterPackage: need("SUI_MESSAGE_TRANSMITTER_V2_ID"),
    messageTransmitterState: need("SUI_MESSAGE_TRANSMITTER_V2_STATE_ID"),
    tokenMessengerMinterPackage: need("SUI_TOKEN_MESSENGER_MINTER_V2_ID"),
    tokenMessengerMinterState: need("SUI_TOKEN_MESSENGER_MINTER_V2_STATE_ID"),
    stablecoinHandlerPackage: need("SUI_STABLECOIN_HANDLER_ID"),
    stablecoinHandlerState: need("SUI_STABLECOIN_HANDLER_STATE_ID"),
    handlerAuthType: `${need("SUI_STABLECOIN_HANDLER_ID")}::handler::Auth`,
    usdcType: `${need("SUI_USDC_ID")}::usdc::USDC`,
    usdcTreasury: need("SUI_TREASURY_ID"),
    denyList: env.SUI_DENY_LIST_ID ?? "0x403",
    clock: "0x6",
  }

  step("localnet CCTP V2 deploy")
  for (const [key, value] of Object.entries(cctp))
    console.log(`  ${key.padEnd(28)} ${value}`)

  // A fresh keypair, funded from the faucet: this pays gas and nothing else,
  // exactly as the mint signer does in production.
  const keypair = new Ed25519Keypair()
  const secret = keypair.getSecretKey()
  const minterAddress = keypair.toSuiAddress()
  step("mint signer")
  console.log(`  address ${minterAddress}`)
  await fundFromFaucet(minterAddress)
  check(true, "funded from the faucet")

  const sui = openSuiMinter({
    key: new Secret(secret),
    network: "mainnet", // only selects the default config, which we override
    rpcUrl: RPC_URL,
    suiNetwork: "localnet",
    config: cctp,
  })
  check((await sui.gasBalance()) > 0n, "mint signer has gas")

  const db = openDb(
    { DATABASE_URL: new Secret(databaseUrl) },
    { schema: "sui_localnet" }
  )
  await db.query("drop schema if exists sui_localnet cascade")
  await db.query("create schema sui_localnet")
  await migrate(db, await readMigrations(), () => {})
  const journal = openJournal(db, "mainnet")

  const recipient = authRecipient(cctp.tokenMessengerMinterPackage)
  // The mint recipient is the signer only so the balance is easy to read back.
  const mintRecipient = minterAddress
  await journal.bindRecipient({
    suiAddress: mintRecipient,
    userRef: "localnet",
  })
  const deposit = await journal.issueDeposit({
    suiAddress: mintRecipient,
    chain: "avalanche",
    forwarderAddress: "0x" + "a".repeat(40),
  })

  /** Stages one burn as validated, the state the mint worker consumes. */
  let burnCounter = 0
  const stage = async (options: {
    finalityThresholdExecuted?: number
    badAttestation?: boolean
  }) => {
    burnCounter += 1
    const nonce = bytes32(
      "0x" +
        (BigInt(Date.now()) * 1_000_000n + BigInt(burnCounter)).toString(16)
    )
    const message = buildMessage({
      nonce,
      sender: need("EVM_TOKEN_MESSENGER_ADDRESS"),
      recipient,
      burnToken: need("EVM_USDC_ADDRESS"),
      mintRecipient,
      messageSender: "0x" + "a".repeat(40),
      amount: AMOUNT,
      finalityThresholdExecuted:
        options.finalityThresholdExecuted ?? FINALITY_EXECUTED,
    })
    const attestation =
      options.badAttestation === true
        ? await (async () => {
            const wrong = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex)
            const signature = await wrong.sign({ hash: keccak256(message) })
            return Uint8Array.from(
              Buffer.from(signature.replace(/^0x/, ""), "hex")
            )
          })()
        : await attest(message)

    const { burn } = await journal.recordBurn({
      depositId: deposit.id,
      chain: "avalanche",
      txHash: "0x" + burnCounter.toString(16).padStart(64, "0"),
      burnIndex: 0,
      blockNumber: BigInt(burnCounter),
      amount: AMOUNT,
    })
    await journal.recordAttestation({
      burnId: burn.id,
      nonce: "0x" + Buffer.from(nonce).toString("hex"),
      message,
      attestation,
      maxFee: 0n,
      feeExecuted: 0n,
    })
    return { burnId: burn.id, nonce: "0x" + Buffer.from(nonce).toString("hex") }
  }

  step("the happy path: a properly attested message")
  const good = await stage({})
  const minted = await mintOnce({ journal, sui })
  check(minted.length === 1, "one message handled")
  check(minted[0]?.kind === "minted", "delivered", JSON.stringify(minted[0]))
  const digest = minted[0]?.kind === "minted" ? minted[0].digest : ""
  check(digest.length > 0, "a Sui digest was recorded", digest)
  check(
    await sui.nonceUsed(good.nonce),
    "Circle's Move code marked the nonce used"
  )
  check(
    (await journal.burnsByStatus("minted", 10)).some(
      (b) => b.id === good.burnId
    ),
    "the journal agrees"
  )
  check(
    (await journal.mintByNonce(good.nonce))?.status === "confirmed",
    "the mint row is confirmed"
  )

  step("a second pass has nothing to do")
  check(
    (await mintOnce({ journal, sui })).length === 0,
    "no validated messages remain"
  )

  step("below Sui's finality threshold: the Move code aborts")
  const low = await stage({ finalityThresholdExecuted: 100 })
  const lowOutcome = await mintOnce({ journal, sui })
  check(
    lowOutcome[0]?.kind === "retry",
    "classified as retry",
    JSON.stringify(lowOutcome[0])
  )
  check(
    !(await sui.nonceUsed(low.nonce)),
    "the nonce is untouched, so the transfer is still deliverable"
  )
  check(
    (await journal.burnsByStatus("validated", 10)).some(
      (b) => b.id === low.burnId
    ),
    "the message is back to validated, not dropped"
  )

  step("an attestation from the wrong key: the Move code rejects it")
  const bad = await stage({ badAttestation: true })
  // The low-threshold message is still validated, so both are handled.
  const badOutcome = await mintOnce({ journal, sui })
  const forBad = badOutcome.find((o) => o.burnId === bad.burnId)
  check(forBad?.kind === "retry", "classified as retry", JSON.stringify(forBad))
  check(!(await sui.nonceUsed(bad.nonce)), "the nonce is untouched")

  await db.close()
  console.log(
    failures === 0
      ? "\nPASS: our receive PTB is accepted by Circle's Move code, the nonce is the\n" +
          "delivery oracle, and real Move aborts preserve the message.\n" +
          "Still unproven, and unprovable here: that Circle attests a forwarder's burn."
      : `\nFAIL: ${failures} check(s) failed.`
  )
  if (failures > 0) process.exit(1)
}

await main()
