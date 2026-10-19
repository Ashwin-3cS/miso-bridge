/**
 * Does Circle's Iris *sandbox* attest a Sui-bound burn?
 *
 * The sibling repo's design doc says there is no testnet path, and its fee
 * endpoint agrees: the sandbox rejects destination domain 8 with "Invalid
 * source/destination domain id", exactly as it rejects a domain that does not
 * exist, while production accepts 1 -> 8 and 7 -> 8. But that endpoint is about
 * fees, which makes it suggestive rather than conclusive, and two facts point
 * the other way: Fuji's and Amoy's TokenMessengerV2 both have a non-zero
 * remote messenger registered for domain 8, and Circle has full CCTP V2
 * packages deployed on Sui testnet.
 *
 * So the on-chain plumbing exists on both ends and only the attester is in
 * doubt. This settles it the only way left: burn a little testnet USDC on Fuji
 * toward a Sui testnet address and see whether the sandbox signs it.
 *
 * It needs no forwarder. The forwarder's constants are mainnet-only, and this
 * question is about Circle's attester, not about our contract, so the burn is
 * made directly by an EOA.
 *
 * Read-only unless --send is passed. A burn here is NOT recoverable: if the
 * sandbox never attests, the testnet USDC is gone. Use a few units.
 *
 *   bun run scripts/fuji-sui-probe.ts                 # preflight only
 *   bun run scripts/fuji-sui-probe.ts --send          # burn and poll
 *   bun run scripts/fuji-sui-probe.ts --poll 0x<hash> # resume polling
 */

import {
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseUnits,
  publicActions,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { avalancheFuji } from "viem/chains"

/**
 * Circle's CCTP V2 testnet TokenMessengerV2, at this address on every
 * supported testnet. The minter is read from it rather than pinned, so a
 * change on Circle's side is followed rather than asserted.
 */
const TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Hex

/**
 * Sui testnet USDC's CCTP token id. Circle's minter maps it to the local USDC.
 * It is keccak256("<usdc package id, without 0x>::usdc::USDC"), a scheme
 * confirmed by reproducing the mainnet constant the sibling repo pins.
 */
const SUI_TESTNET_USDC =
  "0xba0aeb4444ae728084b1536f72ce7f6424c5e59a1d63b7c3af70e9bff3ed3823" as Hex

const SUI_DOMAIN = 8
const FUJI_DOMAIN = 1
/** Standard Transfer, as the forwarder uses. */
const MIN_FINALITY_THRESHOLD = 2000
const SANDBOX = "https://iris-api-sandbox.circle.com"

const messengerAbi = [
  {
    type: "function",
    name: "remoteTokenMessengers",
    inputs: [{ type: "uint32" }],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "localMinter",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "depositForBurn",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const

const minterAbi = [
  {
    type: "function",
    name: "getLocalToken",
    inputs: [{ type: "uint32" }, { type: "bytes32" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "burnLimitsPerMessage",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const

const ZERO32 = `0x${"0".repeat(64)}` as Hex
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...parts: unknown[]) => console.log(...parts)

function argOf(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** Polls the sandbox until it signs the message, or the budget runs out. */
async function poll(txHash: string, minutes: number): Promise<void> {
  const url = `${SANDBOX}/v2/messages/${FUJI_DOMAIN}?transactionHash=${txHash.toLowerCase()}`
  const deadline = Date.now() + minutes * 60_000
  let last = ""
  log(`\npolling the sandbox for up to ${minutes} minutes`)
  log(url)
  while (Date.now() < deadline) {
    const response = await fetch(url)
    const text = await response.text()
    const summary = `HTTP ${response.status} ${text.slice(0, 300)}`
    if (summary !== last) {
      log(`  [${new Date().toISOString()}] ${summary}`)
      last = summary
    }
    if (response.status === 200) {
      const body = JSON.parse(text) as {
        messages?: Array<{ status?: string; attestation?: string | null }>
      }
      const message = body.messages?.[0]
      if (message?.status === "complete" && message.attestation) {
        log("\nVERDICT: the sandbox DOES attest Sui-bound burns.")
        log(
          "A straight-through Fuji -> Sui testnet path exists; tier 3 collapses"
        )
        log("into one route and the design doc's note is out of date.")
        return
      }
    }
    await sleep(15_000)
  }
  log("\nVERDICT: the sandbox did not attest within the window.")
  log("Treat Sui as unattested on the sandbox: keep the Sui localnet route for")
  log("the mint leg, and the bounded mainnet test stays load-bearing.")
}

async function main(): Promise<void> {
  const resume = argOf("--poll")
  const minutes = Number(argOf("--minutes") ?? 30)
  if (resume !== undefined) return poll(resume, minutes)

  const rpcUrl =
    process.env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc"
  const key = process.env.FUJI_KEY
  const recipient = process.env.SUI_RECIPIENT
  const send = process.argv.includes("--send")

  if (key === undefined)
    throw new Error("set FUJI_KEY (a funded Fuji test key)")
  if (recipient === undefined || !/^0x[0-9a-fA-F]{64}$/.test(recipient))
    throw new Error(
      "set SUI_RECIPIENT to a Sui testnet address (0x + 32 bytes)"
    )

  const account = privateKeyToAccount(key as Hex)
  const client = createWalletClient({
    account,
    chain: avalancheFuji,
    transport: http(rpcUrl),
  }).extend(publicActions)

  const chainId = await client.getChainId()
  if (chainId !== avalancheFuji.id)
    throw new Error(
      `RPC is chain ${chainId}, expected Fuji ${avalancheFuji.id}`
    )

  const read = { address: TOKEN_MESSENGER, abi: messengerAbi } as const
  const [suiRemote, minter] = await Promise.all([
    client.readContract({
      ...read,
      functionName: "remoteTokenMessengers",
      args: [SUI_DOMAIN],
    }),
    client.readContract({ ...read, functionName: "localMinter" }),
  ])
  const usdc = await client.readContract({
    address: minter,
    abi: minterAbi,
    functionName: "getLocalToken",
    args: [SUI_DOMAIN, SUI_TESTNET_USDC],
  })
  const [limit, balance, gas] = await Promise.all([
    client.readContract({
      address: minter,
      abi: minterAbi,
      functionName: "burnLimitsPerMessage",
      args: [usdc],
    }),
    client.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    client.getBalance({ address: account.address }),
  ])

  log("preflight on Avalanche Fuji")
  log(`  signer              ${account.address}`)
  log(`  AVAX for gas        ${formatUnits(gas, 18)}`)
  log(`  Sui route (domain 8) ${suiRemote}`)
  log(`  local minter        ${minter}`)
  log(`  native USDC         ${usdc}`)
  log(`  per-message limit   ${formatUnits(limit, 6)} USDC`)
  log(`  signer USDC         ${formatUnits(balance, 6)} USDC`)
  log(`  Sui recipient       ${recipient}`)

  if (suiRemote === ZERO32)
    throw new Error("Fuji has no Sui route; nothing to probe")
  if (usdc === "0x0000000000000000000000000000000000000000")
    throw new Error("the minter does not map Sui testnet USDC on this chain")

  const amount = parseUnits(process.env.AMOUNT_USDC ?? "1", 6)
  if (balance < amount)
    throw new Error(
      `signer holds ${formatUnits(balance, 6)} USDC, needs ${formatUnits(amount, 6)}; ` +
        "get testnet USDC from Circle's faucet"
    )

  if (!send) {
    log("\npreflight only. Re-run with --send to burn and poll.")
    log("A burn is NOT recoverable if the sandbox never attests it.")
    return
  }

  log(`\napproving ${formatUnits(amount, 6)} USDC to the messenger`)
  const approval = await client.sendTransaction({
    to: usdc,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [TOKEN_MESSENGER, amount],
    }),
  })
  await client.waitForTransactionReceipt({ hash: approval })

  log("burning toward Sui (Standard Transfer, maxFee 0, no destination caller)")
  const burn = await client.sendTransaction({
    to: TOKEN_MESSENGER,
    data: encodeFunctionData({
      abi: messengerAbi,
      functionName: "depositForBurn",
      args: [
        amount,
        SUI_DOMAIN,
        recipient as Hex,
        usdc,
        ZERO32,
        0n,
        MIN_FINALITY_THRESHOLD,
      ],
    }),
  })
  const receipt = await client.waitForTransactionReceipt({ hash: burn })
  log(`  ${receipt.status} in block ${receipt.blockNumber}: ${burn}`)
  if (receipt.status !== "success")
    throw new Error("the burn reverted; the sandbox question is unanswered")

  await poll(burn, minutes)
}

await main()
