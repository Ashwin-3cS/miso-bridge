import {
  buildReceiveMessageTransaction,
  isNonceUsed,
  SUI_MAINNET_CCTP_V2,
} from "@misofm/cctp-forwarders/cctp-v2-sui"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Network, Secret } from "../config.js"

/**
 * The Sui side: the nonce oracle and the receive transaction.
 *
 * The PTB is the sibling repo's, which matches real Avalanche and Polygon mint
 * transactions call for call. Minting is permissionless and Sui verifies
 * Circle's attestation itself, paying the recipient encoded in the signed
 * message, so this key pays gas and cannot choose who is paid. A stuck worker
 * delays a transfer; it cannot lose or redirect one.
 *
 * `isNonceUsed` is the delivery oracle. `receive_message` marks the nonce in
 * the same atomic transaction that mints, so a nonce that reads used is
 * delivered -- by us or by anyone else -- and one that reads unused is not.
 * It throws rather than guessing on a failed read, which is what makes it safe
 * to key exactly-once delivery on.
 */

/**
 * The ids a receive PTB needs. Widened from the pinned mainnet constant, whose
 * literal types would otherwise admit only mainnet.
 */
export type SuiCctpConfig = {
  readonly [K in keyof typeof SUI_MAINNET_CCTP_V2]: string
}

/**
 * Circle's CCTP V2 on Sui testnet.
 *
 * Verified: every package and state object below exists on Sui testnet, read
 * from a live fullnode, and the mainnet ids from the same Circle reference
 * match the sibling repo's pinned constants exactly.
 *
 * Not verified: no mint has been executed against these. The two type ids are
 * derived the way the mainnet ones are formed -- a type keeps its defining
 * package id across upgrades -- rather than read back from a real testnet
 * mint. Confirm them against one before relying on this path.
 */
export const SUI_TESTNET_CCTP_V2: SuiCctpConfig = Object.freeze({
  messageTransmitterPackage:
    "0xe9678cd42a81886e18e21361088071f275105636a4d3751e1d7f255211f73bbe",
  messageTransmitterState:
    "0xfee3a2b47f9ef2de2405fc63d79194307945f8ea768815cfc46083bc20fbe6ed",
  tokenMessengerMinterPackage:
    "0x267d3c0cb776eace2840f27e4d33da9c6d952f9749403f1fe6579f4962ed3c64",
  tokenMessengerMinterState:
    "0x72cb55cd14d01e6361386d6ea93eecda9fa1efc3c202b8dd69c1e4683e4c0ca0",
  stablecoinHandlerPackage:
    "0xbe8479044396a45e07de2c7f14789c35b8338406eebc53b2527da56839a91561",
  stablecoinHandlerState:
    "0xfbd9c0517c4f0e1817445ee2be598806e3c392a465d7e3d773d1055f3f0eed32",
  handlerAuthType:
    "0xbe8479044396a45e07de2c7f14789c35b8338406eebc53b2527da56839a91561::handler::Auth",
  usdcType:
    "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  usdcTreasury:
    "0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe",
  denyList: "0x403",
  clock: "0x6",
})

export function suiCctpConfig(network: Network): SuiCctpConfig {
  return network === "mainnet" ? SUI_MAINNET_CCTP_V2 : SUI_TESTNET_CCTP_V2
}

export type SubmitResult =
  | { status: "minted"; digest: string }
  | { status: "aborted"; digest: string; error: string }

export type SuiMinter = {
  readonly address: string
  /** True when MessageTransmitterV2 has already received this nonce. */
  nonceUsed(nonce: string): Promise<boolean>
  /** Dry-runs the receive; a revert comes back rather than throwing. */
  simulate(args: {
    message: Uint8Array
    attestation: Uint8Array
  }): Promise<{ ok: boolean; error?: string }>
  submit(args: {
    message: Uint8Array
    attestation: Uint8Array
  }): Promise<SubmitResult>
  /** SUI balance, for the gas floor alert. */
  gasBalance(): Promise<bigint>
}

export function openSuiMinter(options: {
  key: Secret
  network: Network
  rpcUrl: string
}): SuiMinter {
  const keypair = Ed25519Keypair.fromSecretKey(options.key.reveal())
  const client = new SuiGrpcClient({
    network: options.network,
    baseUrl: options.rpcUrl,
  })
  const config = suiCctpConfig(options.network)
  const address = keypair.toSuiAddress()

  /**
   * The sibling module takes a config argument but types it as the literal
   * mainnet constant, so only that exact object satisfies it. The shape is
   * identical and SuiCctpConfig requires every field, so this cast adds no
   * risk; it is in one place so the upstream fix -- typing that parameter
   * structurally -- removes exactly one line.
   */
  const asPinned = config as typeof SUI_MAINNET_CCTP_V2

  const build = (message: Uint8Array, attestation: Uint8Array) => {
    const tx = buildReceiveMessageTransaction(message, attestation, asPinned)
    tx.setSender(address)
    return tx
  }

  const describe = (
    status: { success: boolean; error: unknown } | undefined
  ) =>
    status === undefined
      ? "no status returned"
      : JSON.stringify(status.error ?? "unknown abort")

  return {
    address,

    nonceUsed: (nonce) => isNonceUsed(client, nonce, asPinned),

    async simulate({ message, attestation }) {
      const response = await client.simulateTransaction({
        transaction: build(message, attestation),
        include: { effects: true },
      })
      const status = (response.Transaction ?? response.FailedTransaction)
        ?.status
      return status?.success === true
        ? { ok: true }
        : { ok: false, error: describe(status) }
    },

    async submit({ message, attestation }) {
      const result = await client.signAndExecuteTransaction({
        transaction: build(message, attestation),
        signer: keypair,
        include: { effects: true },
      })
      const executed = result.Transaction ?? result.FailedTransaction
      if (executed === undefined) throw new Error("Sui returned no transaction")
      // A resolved promise means the network executed it, not that it
      // succeeded, so wait before anything reads the effects back.
      await client.waitForTransaction({ digest: executed.digest })
      return executed.status.success
        ? { status: "minted", digest: executed.digest }
        : {
            status: "aborted",
            digest: executed.digest,
            error: describe(executed.status),
          }
    },

    async gasBalance() {
      // Decimal strings, never numbers: a SUI balance does not fit a double.
      const { balance } = await client.getBalance({ owner: address })
      return BigInt(balance.balance)
    },
  }
}
