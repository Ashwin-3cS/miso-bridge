/**
 * Tier 2: the watcher, crank and discovery against real Circle contracts.
 *
 * Unit tests inject every edge, so they prove the logic and nothing about
 * Circle. This runs the actual workers against a forked Avalanche mainnet with
 * the real TokenMessengerV2, TokenMinterV2 and USDC, a real keyless CREATE2
 * deployment of the forwarder, and a real burn -- for no money.
 *
 * Setup, once per fork:
 *
 *   anvil --fork-url https://api.avax.network/ext/bc/C/rpc --port 8545
 *   cd vendor/cctp-forwarders/forwarders/evm
 *   forge install foundry-rs/forge-std@v1.16.2 --no-git
 *   forge install Vectorized/solady@acd959aa4bd04720d640bf4e6a5c71037510cc4b --no-git
 *   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
 *     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *
 * Then:
 *
 *   DATABASE_URL=postgres://bridge:bridge@localhost:5433/bridge \
 *     bun run scripts/fork-rehearsal.ts
 *
 * It mints USDC to the deposit address by impersonating USDC's master minter,
 * which is a fork-only power and the reason this is not a mainnet test.
 */

import {
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  publicActions,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { avalanche } from "viem/chains"
import { Secret } from "../src/config.js"
import { createEvmRpc } from "../src/chain/evm.js"
import { openSigner } from "../src/chain/signer.js"
import { openDb } from "../src/db.js"
import { depositAddress, forwarderBuild, usdcFor } from "../src/forwarder.js"
import { openJournal } from "../src/journal.js"
import { migrate, readMigrations } from "../src/migrate.js"
import { crankOnce } from "../src/workers/crank.js"
import { discoverOnce } from "../src/workers/discover.js"
import { watchOnce } from "../src/workers/watcher.js"
import { formatUsdc } from "../src/usdc.js"

const ANVIL_URL = process.env.ANVIL_URL ?? "http://127.0.0.1:8545"
/** anvil's first default account; a fork-only key, never a real one. */
const ANVIL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex
const ANVIL_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Hex
/** The fifth fixture vector, so the derived address is a published value. */
const RECIPIENT =
  process.env.RECIPIENT ??
  "0x7a1d4e3b9c5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f708"
const AMOUNT = 7_000_000n
const DEPOSIT_FOR_BURN_TOPIC0 =
  "0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5"

const usdcAbi = [
  {
    type: "function",
    name: "masterMinter",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "configureMinter",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const

const forwarderViewAbi = [
  {
    type: "function",
    name: "addressOf",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
] as const

/** JSON that survives a bigint, which every gas and amount here is. */
const show = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v))

let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures += 1
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `  (${detail})`}`
  )
}
const step = (label: string) => console.log(`\n${label}`)

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined) throw new Error("set DATABASE_URL")

  const client = createWalletClient({
    account: privateKeyToAccount(ANVIL_KEY),
    chain: avalanche,
    transport: http(ANVIL_URL),
  }).extend(publicActions)

  const build = forwarderBuild("mainnet")
  const instance = build.instance as Hex
  const usdc = usdcFor("mainnet", "avalanche") as Hex

  step("preconditions")
  const chainId = await client.getChainId()
  check(chainId === avalanche.id, "fork is Avalanche C-Chain", String(chainId))
  const instanceCode = await client.getCode({ address: instance })
  check(
    instanceCode !== undefined && instanceCode.length > 2,
    "forwarder instance is deployed",
    instance
  )
  if (failures > 0)
    throw new Error("run the Deploy.s.sol step first; see this file's header")

  step("address derivation agrees with the chain")
  const derived = depositAddress("mainnet", RECIPIENT)
  const onChain = await client.readContract({
    address: instance,
    abi: forwarderViewAbi,
    functionName: "addressOf",
    args: [RECIPIENT as Hex],
  })
  check(
    derived.toLowerCase() === onChain.toLowerCase(),
    "TypeScript matches addressOf",
    derived
  )
  const hadCode = await client.getCode({ address: derived as Hex })
  check(
    hadCode === undefined || hadCode.length <= 2,
    "deposit address has no code yet"
  )

  step("funding the deposit address with real USDC (fork-only)")
  const masterMinter = await client.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: "masterMinter",
  })
  for (const account of [masterMinter, ANVIL_ACCOUNT]) {
    await client.request({
      method: "anvil_impersonateAccount",
      params: [account],
    } as never)
    await client.request({
      method: "anvil_setBalance",
      params: [account, "0xde0b6b3a7640000"],
    } as never)
  }
  const sendAs = async (from: Hex, to: Hex, data: Hex) => {
    const hash = (await client.request({
      method: "eth_sendTransaction",
      params: [{ from, to, data, gas: "0x100000" }],
    } as never)) as Hex
    return client.waitForTransactionReceipt({ hash })
  }
  await sendAs(
    masterMinter,
    usdc,
    encodeFunctionData({
      abi: usdcAbi,
      functionName: "configureMinter",
      args: [ANVIL_ACCOUNT, 10n ** 12n],
    })
  )
  await sendAs(
    ANVIL_ACCOUNT,
    usdc,
    encodeFunctionData({
      abi: usdcAbi,
      functionName: "mint",
      args: [derived as Hex, AMOUNT],
    })
  )
  const funded = await client.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [derived as Hex],
  })
  check(
    funded === AMOUNT,
    "deposit address holds the USDC",
    `${formatUnits(funded, 6)} USDC`
  )

  step("journal")
  const db = openDb(
    { DATABASE_URL: new Secret(databaseUrl) },
    { schema: "fork_rehearsal" }
  )
  await db.query("drop schema if exists fork_rehearsal cascade")
  await db.query("create schema fork_rehearsal")
  await migrate(db, await readMigrations(), () => {})
  const journal = openJournal(db, "mainnet")
  await journal.bindRecipient({
    suiAddress: RECIPIENT,
    userRef: "fork-rehearsal",
  })
  const deposit = await journal.issueDeposit({
    suiAddress: RECIPIENT,
    chain: "avalanche",
    forwarderAddress: derived,
  })
  await journal.markHot(deposit.id, 3_600)
  check(deposit.status === "issued", "deposit issued", `id ${deposit.id}`)

  step("watcher (reads latest)")
  const rpc = createEvmRpc({ url: ANVIL_URL, chain: "avalanche" })
  const watched = await watchOnce({
    journal,
    rpc,
    chain: "avalanche",
    usdc,
    floor: 1_000_000n,
  })
  check(watched.polled === 1, "polled the hot address")
  check(
    watched.fundable.includes(deposit.id),
    "saw the deposit and marked it fundable"
  )
  check(watched.totalObserved === AMOUNT, "observed the right balance")

  step("crank (deploy and burn in one call)")
  const signer = openSigner({
    key: new Secret(ANVIL_KEY),
    network: "mainnet",
    chain: "avalanche",
    rpcUrl: ANVIL_URL,
    maxFeeGwei: 200,
  })
  const outcome = await crankOnce(
    { journal, rpc, signer, instance, budget: 24 },
    deposit.id
  )
  check(outcome.kind === "submitted", "crank submitted", show(outcome))
  if (outcome.kind !== "submitted") throw new Error("crank did not submit")
  check(outcome.deployed === false, "took the deploy-and-forward path")

  const receipt = await client.getTransactionReceipt({ hash: outcome.hash })
  const burnLogs = receipt.logs.filter(
    (log) => log.topics[0] === DEPOSIT_FOR_BURN_TOPIC0
  )
  check(burnLogs.length === 1, "exactly one DepositForBurn")
  const depositor = "0x" + (burnLogs[0]?.topics[2] ?? "").slice(26)
  check(
    depositor.toLowerCase() === derived.toLowerCase(),
    "Circle's depositor is the deposit address, not the cranker",
    depositor
  )
  check(
    (await client.readContract({
      address: usdc,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [derived as Hex],
    })) === 0n,
    "the whole balance was burned"
  )
  const nowHasCode = await client.getCode({ address: derived as Hex })
  check(
    nowHasCode !== undefined && nowHasCode.length > 2,
    "the clone was deployed"
  )
  console.log(`  gas used: ${outcome.gasUsed}`)

  step("discovery respects finality")
  const discover = {
    journal,
    rpc,
    chain: "avalanche" as const,
    // Small, so the rehearsal does not crawl the whole default lookback, and
    // 100-block windows because that is the public endpoint's cap.
    initialLookback: 200n,
    windowBlocks: 100n,
  }
  const beforeFinality = await discoverOnce(discover)
  check(
    beforeFinality.found === 0,
    "the burn is not discovered before it is finalized",
    `scanned ${beforeFinality.scanned} deposits to block ${beforeFinality.to}`
  )
  check(
    (await journal.depositById(deposit.id))?.status === "cranking",
    "the deposit stays cranking until the log is finalized"
  )

  await client.request({ method: "anvil_mine", params: ["0x50"] } as never)
  const afterFinality = await discoverOnce(discover)
  check(afterFinality.found === 1, "the burn is discovered once finalized")

  const burns = await journal.burnsForDeposit(deposit.id)
  check(burns.length === 1, "one burn recorded")
  check(
    burns[0]?.amount === AMOUNT,
    "the recorded amount matches",
    formatUsdc(burns[0]?.amount ?? 0n)
  )
  check(burns[0]?.status === "discovered", "the burn is awaiting attestation")
  check(
    (await journal.depositById(deposit.id))?.status === "cranked",
    "the deposit is now cranked -- from the log, not the receipt"
  )

  step("rediscovery is idempotent")
  const again = await discoverOnce(discover)
  check(again.found === 0, "a second pass creates no second burn")
  check(
    (await journal.burnsForDeposit(deposit.id)).length === 1,
    "still one burn"
  )

  await db.close()

  console.log(
    failures === 0
      ? "\nPASS: the crank burned real USDC through real Circle contracts, and the journal\nagrees with the chain."
      : `\nFAIL: ${failures} check(s) failed.`
  )
  if (failures > 0) process.exit(1)
}

await main()
