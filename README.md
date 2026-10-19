# miso-bridge

The middleman service for Miso's Circle CCTP V2 forwarders. It issues per-user deposit
addresses on Avalanche C-Chain and Polygon PoS, notices deposits, cranks the keyless
forwarder burn, relays Circle's attestation and mints native USDC into the user's Sui
account — with a durable journal, exactly-once accounting and an alert on anything that
stalls.

## Two repositories, and which is which

CCTP has no concept of "pay this address and it bridges": it has a call, made by whoever
holds the USDC. An onramp can only pay an address. Closing that gap takes a contract and
a service, and they live apart.

|                      | Repository                                                          | What it is                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The forwarder**    | [misofm/cctp-forwarders](https://github.com/misofm/cctp-forwarders) | The keyless `Forwarder` contract deployed on Avalanche and Polygon, plus the pure modules that derive deposit addresses, discover burns, fetch and validate Circle attestations and build the Sui receive PTB. Its `docs/design.md` is the safety argument. Nothing in it runs on its own. |
| **The microservice** | **this repository**                                                 | The thing that runs: the HTTP API, six workers, the journal and the alerting. It imports the forwarder repo pinned as a submodule under `vendor/` and never reimplements any of it.                                                                                                        |

The division is deliberate. The forwarder is reviewed, immutable and holds the funds; this
service is operational, redeployable and holds none.

## What this service can and cannot do

It holds no USDC and has no path to move any. Its keys pay gas only: cranking a forwarder
is permissionless and chooses nothing, and the Sui mint pays the recipient encoded in
Circle's signed message. A fully compromised bridge key can delay a transfer. It cannot
redirect one.

## Layout

- `src/api/`: HTTP surface consumed by the app (issue an address, read a deposit).
- `src/workers/`: watcher, crank, discover, iris, mint, reconcile (and the slow sweep).
- `src/chain/`: EVM JSON-RPC with the chain-id guard, the gas-only signers, Sui client.
- `src/journal.ts`: the only module that writes state transitions.
- `migrations/`: plain SQL, applied by `src/migrate.ts`.
- `vendor/cctp-forwarders/`: the pinned forwarder repo. Never reimplement it here.

## Development

```sh
bun install --frozen-lockfile
bun run db:up            # local Postgres on 5433
bun run migrate
bun run format:check
bun run lint
bun run typecheck
bun run test             # offline; skips the suites that need Postgres
bun run test:db          # the whole suite, against the local Postgres
bun run build
```

Unit tests need no funded accounts, no RPC credentials and no network.

## Tests

**238 passing across 17 files** (`bun run test:db`). Offline, `bun run test` runs 171 of
them and skips the 68 that need Postgres rather than inventing a database.

| Suite                   | Tests | What it pins                                                                                                                                                                                                                                   |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.test.ts`           | 61    | Issuing is idempotent and refuses a zero, malformed or deny-listed recipient; a crank nudge changes no state; 503 rather than an invented address on a network with no forwarder build; the user-facing phase table; constant-time bearer auth |
| `journal.test.ts`       | 23    | Lock contention for both the crank and the nonce; replayed discovery creating one burn; a released mint returning to validated; a minted burn refusing to be quarantined after the fact                                                        |
| `transitions.test.ts`   | 18    | The state machines as graph reachability — a quarantined burn can never reach minted by any route — and that the tables match the SQL check constraints                                                                                        |
| `evm.test.ts`           | 17    | The chain-id guard, including that a failure is not cached; batch results matched by id, not position                                                                                                                                          |
| `reverts.test.ts`       | 13    | Circle's conditions classified as _wait_, our own gas problems as _retry_, unknown reverts as wait-and-alert                                                                                                                                   |
| `config.test.ts`        | 12    | Every path by which a secret could reach a log line                                                                                                                                                                                            |
| `crank.test.ts`         | 12    | Deploy-and-burn on first crank, direct call after; never recording a burn from a receipt; the per-address gas budget                                                                                                                           |
| `forwarder.test.ts`     | 11    | Derivation parity against the Solidity-generated address vectors                                                                                                                                                                               |
| `discover.test.ts`      | 10    | Windows never exceeding the provider's cap, contiguous coverage, the cursor recording exactly what was scanned                                                                                                                                 |
| `mint.test.ts`          | 10    | Exactly-once delivery keyed on the nonce, including a submission that throws after landing                                                                                                                                                     |
| `iris.test.ts`          | 9     | Circle's real captured attestation validating; a tampered copy quarantined; another party's message left alone                                                                                                                                 |
| `main.test.ts`          | 8     | Role wiring needs no signing key, so a read-only staging run starts without one                                                                                                                                                                |
| `observability.test.ts` | 8     | An alert pages once, re-pages after clearing, and survives a dead webhook                                                                                                                                                                      |
| `loop.test.ts`          | 7     | Backoff schedule and prompt shutdown                                                                                                                                                                                                           |
| `reconcile.test.ts`     | 7     | Each stuck leg paging separately; Circle refusing a burn as a notice, not a page; no state written                                                                                                                                             |
| `sweep.test.ts`         | 6     | Balances recorded, not merely reported, and paging that wraps around                                                                                                                                                                           |
| `watcher.test.ts`       | 6     | Balance N recorded against deposit N, and `latest` rather than `finalized`                                                                                                                                                                     |

## Verification beyond unit tests

Four tiers, because no single one covers the path. Tiers 1 and 2 cost nothing.

**1. Unit and fixture replay — run, passing.** Includes the forwarder repo's captured
Circle attestation and Sui mint, so the byte layouts under test are ones Circle really
produced.

**2. Mainnet fork — run, passing.** `scripts/fork-rehearsal.ts` runs the real watcher,
crank and discovery against a forked Avalanche mainnet with Circle's live
TokenMessengerV2, TokenMinterV2 and USDC, a real keyless CREATE2 deployment and a real
burn, for no money. Setup is in that file's header. It establishes:

- the TypeScript derivation equals the instance's own `addressOf` on chain;
- the first crank deploys the clone and burns in one transaction, at ~173k gas;
- **Circle's `DepositForBurn` depositor is the deposit address, not the cranker** — the
  property the whole safety argument rests on, and one nothing outside Solidity had
  checked;
- discovery does not see the burn before it is finalized, the deposit stays `cranking`
  until it does, and a second pass creates no second burn.

The forwarder repo's own 14 Solidity unit tests also pass here, including its
fixture-matches-current-build check, which proves this toolchain reproduces the exact
build the pinned instance address came from. Its fork tests were **not** run: they need
archive RPCs at pinned blocks.

**3. Testnet — the mint half run and passing; the attestation half still blocked.**
Circle's Iris sandbox does not attest Sui-bound messages, so this tier splits.

- `scripts/sui-localnet-mint.ts` runs the real mint worker against Circle's own Move code
  on a local Sui network with our own attester enrolled. Passing: the receive PTB is
  accepted, the nonce flag behaves as the delivery oracle, and two genuine Move aborts — a
  finality value below Sui's floor, and an attestation from the wrong key — leave the
  message validated and the nonce untouched rather than dropping a transfer.
- The attestation half needs a testnet forwarder build, which needs two changed constants
  in the forwarder repo. `scripts/fuji-sui-probe.ts` settles whether the split is still
  necessary; its preflight has been run against live Fuji, the burn has not.

**4. Bounded mainnet test — not run.** Launch gate 1. Needs explicit approval, a budget
and gas-only keys.

### What is still unverified

- **Whether Circle attests a burn whose depositor is a contract.** Every captured mainnet
  transfer was burned by a wallet. Mechanically there is no reason Iris would differ — it
  watches the messenger's event, not the caller — but it has not been observed, and only
  mainnet can answer it.
- **Polygon end to end.** Only Avalanche was fork-tested. Same bytecode and the same
  messenger address, so parity is expected, not demonstrated.
- **Unattended operation under real timing**, and anything about future Circle policy.

Nothing here claims the funded flow works until tier 4 has run.
