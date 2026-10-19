import {
  EVM_CHAINS,
  FORWARDER_INSTANCE,
  forwarderAddress,
  type EvmChain,
} from "@misofm/cctp-forwarders/evm-forwarder"
import type { Network } from "./config.js"

/**
 * Which forwarder build this service is talking to, and the deposit address
 * of a Sui recipient under it.
 *
 * A deposit address is a pure function of the recipient and the forwarder's
 * creation code. Changing any constant in the contract changes the creation
 * code, so the instance address and every deposit address change with it:
 * mainnet and testnet are different builds with different addresses, and the
 * network is never inferred from an RPC.
 *
 * Derivation itself is not implemented here. It lives in the reviewed sibling
 * repository, with parity tests against Solidity-generated vectors; a second
 * implementation would be a second thing to get wrong.
 */

export type ForwarderBuild = {
  readonly network: Network
  /** The instance, which is both the factory and the clone implementation. */
  readonly instance: string
  readonly chains: readonly EvmChain[]
}

/**
 * Testnet is deliberately absent rather than guessed. A testnet forwarder
 * needs Circle's testnet TokenMessengerV2 and the Sui-testnet USDC token id
 * compiled in, which produces a different instance address — a value that must
 * be pinned from a build in the sibling repository, not computed here.
 */
const builds: Readonly<Record<Network, ForwarderBuild | null>> = Object.freeze({
  mainnet: Object.freeze({
    network: "mainnet",
    instance: FORWARDER_INSTANCE,
    chains: Object.freeze(Object.keys(EVM_CHAINS) as EvmChain[]),
  }),
  testnet: null,
})

export class NoForwarderBuild extends Error {
  constructor(network: Network) {
    super(
      `no forwarder build for ${network}: the contract pins Circle's mainnet ` +
        `TokenMessengerV2 and Sui mainnet's USDC token id, so it cannot be ` +
        `deployed elsewhere. A ${network} build changes both constants, which ` +
        `changes the creation code and so every deposit address; pin its ` +
        `instance in @misofm/cctp-forwarders and add it here.`
    )
    this.name = "NoForwarderBuild"
  }
}

export function forwarderBuild(network: Network): ForwarderBuild {
  const build = builds[network]
  if (build === null) throw new NoForwarderBuild(network)
  return build
}

export function hasForwarderBuild(network: Network): boolean {
  return builds[network] !== null
}

/**
 * The deposit address of a 32-byte Sui recipient. Throws on a malformed or
 * zero recipient: Circle refuses a zero mint recipient, so such an address
 * could never forward and must never be shown.
 */
export function depositAddress(network: Network, suiRecipient: string): string {
  forwarderBuild(network)
  return forwarderAddress(suiRecipient.toLowerCase())
}

/** The chains a recipient's address accepts under this build. */
export function chainsFor(network: Network): readonly EvmChain[] {
  return forwarderBuild(network).chains
}

export type { EvmChain }
