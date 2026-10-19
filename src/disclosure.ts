import type { EvmChain } from "./forwarder.js"

/**
 * What a user must be shown before a deposit address is. The substance comes
 * from the sibling repository's docs/design.md, which is the reviewed
 * statement of what a forwarder can and cannot do; this is the copy the app
 * renders, kept in source so a code review covers it.
 *
 * The honest parts are the ones that cannot be softened: there is no recovery
 * path, the address is single-use, and USDC that Circle will not burn stays
 * where it is.
 */

const names: Readonly<Record<EvmChain, string>> = {
  avalanche: "Avalanche",
  polygon: "Polygon",
}

const nativeGas: Readonly<Record<EvmChain, string>> = {
  avalanche: "AVAX",
  polygon: "POL",
}

/** Joins as "Avalanche or Polygon", or "A, B or C" for longer lists. */
function orList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`
}

export function disclosure(chains: readonly EvmChain[]): string {
  const networks = orList(chains.map((chain) => names[chain]))
  const gas = orList([...new Set(chains.map((chain) => nativeGas[chain]))])
  return [
    `This deposit address works only for native USDC on ${networks}, and only `,
    `ever forwards to your Miso Sui account. Nobody — including Miso — can `,
    `move funds from it any other way. If Circle stops or blocks transfers `,
    `from this address (for example by pausing, retiring or changing its `,
    `bridge, or by blocking the address), USDC sent to it may stay there `,
    `permanently. Other tokens (including bridged USDC.e) and native ${gas} `,
    `cannot be recovered, and USDC sent on any other network may not be. Use `,
    `this address for this top-up only; do not save it for later payments. `,
    `Transfers normally arrive within seconds to a minute, and Circle charges `,
    `no fee today. Miso charges no fee for this. If your Sui account is ever `,
    `blocked by Circle on Sui, a transfer that has already left waits until `,
    `the block is lifted.`,
  ].join("")
}
