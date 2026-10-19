# miso-bridge

The middleman service for Miso's Circle CCTP V2 forwarders. It issues per-user deposit
addresses on Avalanche C-Chain and Polygon PoS, notices deposits, cranks the keyless
forwarder burn, relays Circle's attestation and mints native USDC into the user's Sui
account — with a durable journal, exactly-once accounting and an alert on anything that
stalls.

The forwarder contract and the pure CCTP modules live in
[misofm/cctp-forwarders](https://github.com/misofm/cctp-forwarders), pinned here as a
submodule under `vendor/`. That repository's `docs/design.md` is the safety argument;
this one is the thing that runs.

## What this service can and cannot do

It holds no USDC and has no path to move any. Its keys pay gas only: cranking a forwarder
is permissionless and chooses nothing, and the Sui mint pays the recipient encoded in
Circle's signed message. A fully compromised bridge key can delay a transfer. It cannot
redirect one.

## Layout

- `src/api/`: HTTP surface consumed by the app (issue an address, read a deposit).
- `src/workers/`: watcher, crank, discover, iris, mint, reconcile.
- `src/chain/`: EVM JSON-RPC with the chain-id guard, the gas-only signers, Sui client.
- `src/journal.ts`: the only module that writes state transitions.
- `migrations/`: plain SQL, applied by `src/migrate.ts`.
- `vendor/cctp-forwarders/`: pinned sibling repo — address derivation, burn discovery,
  Iris fetch and validation, the Sui receive PTB. Never reimplement these here.

## Development

```sh
bun install --frozen-lockfile
bun run db:up            # local Postgres on 5433
bun run migrate
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Unit tests need no funded accounts, no RPC credentials and no network.
`bun run test:db` adds the journal and API suites against a local Postgres.

## Verification

Four tiers, because no single one covers the path. Tiers 1 and 2 run for free.

1. **Unit and fixture replay** — `bun run test`. Includes the sibling repo's
   captured Circle attestation and Sui mint, so the byte layouts under test are
   ones Circle really produced.
2. **Mainnet fork** — `scripts/fork-rehearsal.ts` runs the watcher, crank and
   discovery against a forked Avalanche mainnet with the real TokenMessengerV2,
   TokenMinterV2 and USDC, a real keyless CREATE2 deployment and a real burn,
   for no money. Setup is in that file's header. It asserts the property the
   whole design rests on: Circle's depositor is the deposit address, not
   whoever paid the gas.
3. **Testnet** — Circle's sandbox does not attest Sui-bound messages, so this
   splits: a supported sandbox route for the attestation and relay path, and a
   Sui localnet with our own enrolled attester for the mint path.
   `scripts/fuji-sui-probe.ts` settles whether the split is still necessary.
4. **Bounded mainnet test** — launch gate 1. Needs explicit approval, a budget
   and gas-only keys, and nothing here claims the funded flow works until it
   has run.
