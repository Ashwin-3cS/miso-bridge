import {
  createWalletClient,
  encodeFunctionData,
  http,
  publicActions,
  type Chain,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { avalanche, avalancheFuji, polygon, polygonAmoy } from "viem/chains"
import type { EvmChain } from "@misofm/cctp-forwarders/evm-forwarder"
import type { Network, Secret } from "../config.js"

/**
 * The gas-only crank signer.
 *
 * This key pays gas and nothing else. `forward` takes no argument that affects
 * the outcome and the forwarder has no function that can move USDC anywhere
 * but Circle's burn to the recipient fixed in its own code, so a stolen crank
 * key buys an attacker the ability to crank addresses -- which anyone can
 * already do -- and to waste our gas. It cannot redirect a cent.
 *
 * Simulation comes before every send: a revert classified as a Circle
 * condition should cost no gas at all.
 */

export const forwarderAbi = [
  {
    type: "function",
    name: "forward",
    inputs: [{ name: "recipient", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forward",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const

const chains: Readonly<Record<Network, Record<EvmChain, Chain>>> = {
  mainnet: { avalanche, polygon },
  testnet: { avalanche: avalancheFuji, polygon: polygonAmoy },
}

export function viemChain(network: Network, chain: EvmChain): Chain {
  return chains[network][chain]
}

export type SendResult =
  | { status: "mined"; hash: Hex; gasUsed: bigint }
  | { status: "reverted"; hash: Hex; message: string }

export type Signer = {
  readonly address: Hex
  readonly chain: EvmChain
  /** Native-token balance, for the gas floor alert. */
  gasBalance(): Promise<bigint>
  /** Reverts are returned, not thrown: most are Circle conditions. */
  simulate(args: {
    to: Hex
    data: Hex
  }): Promise<{ ok: boolean; message?: string }>
  send(args: { to: Hex; data: Hex }): Promise<SendResult>
}

export function openSigner(options: {
  key: Secret
  network: Network
  chain: EvmChain
  rpcUrl: string
  /** Refuse to send above this, so a fee spike cannot drain the wallet. */
  maxFeeGwei: number
}): Signer {
  const account = privateKeyToAccount(options.key.reveal() as Hex)
  const chain = viemChain(options.network, options.chain)
  const client = createWalletClient({
    account,
    chain,
    transport: http(options.rpcUrl),
  }).extend(publicActions)
  const maxFeePerGas = BigInt(Math.round(options.maxFeeGwei * 1e9))

  return {
    address: account.address,
    chain: options.chain,

    gasBalance: () => client.getBalance({ address: account.address }),

    async simulate({ to, data }) {
      try {
        await client.call({ account, to, data })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    },

    async send({ to, data }) {
      const gas = await client.estimateGas({ account, to, data })
      const hash = await client.sendTransaction({
        to,
        data,
        // A 20% headroom over the estimate: the clamp and fee lookups the
        // forwarder makes can cost more at execution than at estimation.
        gas: (gas * 12n) / 10n,
        maxFeePerGas,
        maxPriorityFeePerGas: maxFeePerGas / 10n,
      })
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success")
        return {
          status: "reverted",
          hash,
          message: "transaction reverted on chain",
        }
      return { status: "mined", hash, gasUsed: receipt.gasUsed }
    },
  }
}

/** Calldata for the first crank of an address: deploy the clone, then burn. */
export function deployAndForwardData(suiRecipient: Hex): Hex {
  return encodeFunctionData({
    abi: forwarderAbi,
    functionName: "forward",
    args: [suiRecipient],
  })
}

/** Calldata for a later crank, called directly on the deposit address. */
export function forwardData(): Hex {
  return encodeFunctionData({
    abi: forwarderAbi,
    functionName: "forward",
    args: [],
  })
}
