# Operations

What to run, what each alert means, and what not to do about it. The governing
fact behind all of it: **a forwarder has no recovery path.** USDC that Circle
will not burn stays at the deposit address, and no key anywhere — including
ours — can move it. So the right response to almost every alert here is to fix
the condition and let the crank retry, never to improvise a rescue.

## Running it

```sh
bun run src/main.ts api        # HTTP only, no loops, no keys needed
bun run src/main.ts watcher    # balances, per chain
bun run src/main.ts crank      # the only role that signs an EVM transaction
bun run src/main.ts discover   # finalized DepositForBurn logs
bun run src/main.ts iris       # Circle attestations and validation
bun run src/main.ts mint       # the only role that signs a Sui transaction
bun run src/main.ts reconcile  # deadlines, alerts, the slow sweep
bun run src/main.ts all        # everything, for development
```

Each role builds only what it needs. `discover` and `iris` start with no
signing key at all, which is what makes a read-only staging run possible. A key
missing for the role that needs it fails on that role's first tick, naming the
variable.

Running two of a role is safe. Claims are taken under Postgres advisory locks
and the mints table is keyed by nonce, so two crankers never pay gas for one
address and two mint workers cannot mint one transfer twice.

`SIGTERM` stops the loops, closes the pool and exits.

## Alerts

| Alert                            | Severity | What it means                                                                                             | What to do                                                                                                                                                     |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crank-produced-no-burn`         | page     | A crank was submitted and no finalized `DepositForBurn` followed within the deadline                      | Check the transaction. A reorg replays harmlessly. If the transaction succeeded but discovery has not caught up, check `discover` is running and not `behind`. |
| `crank-refused`                  | page     | A crank reverted for a reason worth a human: a pause, a blacklist, a zero burn limit, a missing Sui route | Confirm against Circle's status. The funds are at the address and the same crank succeeds once it is lifted. Do nothing else.                                  |
| `waiting-on-circle`              | notice   | A deposit has been waiting on a Circle condition longer than expected                                     | Expected, and the funds are in place. Watch it clear.                                                                                                          |
| `burn-not-attested`              | page     | Circle has not signed a burn within the deadline                                                          | Check `delayReason` on the burn and Circle's status page. The burn is final; the attestation will come or Circle has a problem.                                |
| `attested-but-not-minted`        | page     | A validated message has not reached Sui                                                                   | Check `mint` is running and has gas. Minting is permissionless, so anyone can deliver it; the nonce is the oracle.                                             |
| `burn-quarantined`               | page     | An attested message claimed to come from one of our forwarders and is not that forwarder's burn           | **Investigate before anything else.** This should be impossible. Do not mint it by hand; the schema will refuse.                                               |
| `balance-at-issued-address`      | notice   | The slow sweep found USDC at an address, including ones the hot set had forgotten                         | Normally the crank picks it up on the next tick. If it is dust below the floor, it stays until more arrives.                                                   |
| `crank-gas-low` / `mint-gas-low` | page     | A gas wallet is below its floor                                                                           | Top it up. These keys pay gas only; losing one delays transfers, it cannot lose funds.                                                                         |

## Circle conditions, and why they are not emergencies

A crank that reverts is usually Circle's policy, not a bug:

- **Paused**, **blacklisted**, **denylisted**, **zero burn limit**, **no Sui
  route** — the USDC stays at the address and the same crank succeeds once the
  condition is lifted.
- **Minimum fee above 1%** — the forwarder refuses by design, since it
  authorises only Circle's own on-chain minimum and never more than 1%. It
  clears when the fee falls or when more USDC arrives at the address, which
  lowers the fee as a proportion.
- **Per-message burn limit below the balance** — the forwarder burns the limit
  and the remainder is drained over several cranks. Nothing to do.

A denylisted _cranker_ blocks only its own transaction, because Circle checks
`tx.origin`. Rotating the crank key works around it.

## On testnet, a Sui-bound burn hangs forever

Circle's Iris **sandbox** does not attest messages bound for Sui (domain 8),
while the on-chain route is registered on Fuji and Amoy and Circle has CCTP V2
packages on Sui testnet. So a testnet burn to Sui **succeeds on chain and is
never attested**. It will look exactly like a stalled pipeline, and the testnet
USDC is gone.

Do not debug it as an incident. `scripts/fuji-sui-probe.ts` is the one-shot
check of whether this is still true. Alerts carry the network for this reason:
a testnet stall must never page anyone.

## Periodic checks (launch gate 5)

Weekly, or after any Circle notice:

- Burn limits, pause flags and the minimum fee on both chains.
- Domain 8 registered on both `TokenMessengerV2`s, and Sui's registration of
  domains 1 and 7.
- Circle's Sui package ids against the call targets the mint uses. A package
  upgrade changes them, and the mint fails until they are updated.
- The Sui deny-list status of each recipient before an address is issued.
- That the code at the pinned forwarder instance is still the reviewed build.

## Key rotation

Crank and mint keys are gas-only and low-balance. To rotate one: fund the new
address, change the variable, restart that role. No state refers to a signer,
nothing is in flight that depends on one, and a transfer mid-flight is
delivered by whoever cranks or mints next — including a third party.

There is no key that can move USDC. There is nothing else to rotate.

## Drills worth running before launch

1. Stop the `mint` role with a validated message outstanding. Confirm
   `attested-but-not-minted` pages, then restart and confirm delivery.
2. Point `AVALANCHE_RPC_URL` at Polygon. Confirm the chain-id guard refuses it
   loudly rather than reading plausible nonsense from the wrong chain.
3. Drain a crank wallet. Confirm `crank-gas-low` pages and that the deposit is
   released for retry rather than marked as waiting on Circle.
4. Set `CRANK_FLOOR_USDC` above a funded balance. Confirm nothing is cranked and
   the sweep still reports the balance.
