# miso-bridge Agent Guide

This repository owns the operational middle of Miso's USDC→Sui path: deposit-address
issuance, the forwarder crank, Circle attestation relay, the Sui mint, and the journal and
alerting around them. Start with README.md, then `vendor/cctp-forwarders/docs/design.md`,
whose launch gates 4–7 are this repository's scope.

Run `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test` and
`bun run build` before pushing. Keep the lockfile committed.

Import address derivation, burn discovery, Iris fetching, message validation and the Sui
receive PTB from `@misofm/cctp-forwarders/*` (the pinned submodule). Do not re-derive an
address, re-decode a message or rebuild the PTB here: those are the reviewed parts, and a
second implementation is a second thing to get wrong. Bump the submodule deliberately, in
its own commit.

This service must never gain a way to move USDC. No code path may choose a mint recipient,
hold user funds, or sign anything but a gas-paying crank and a Sui mint of an
already-attested message. Keys are gas-only and low-balance.

Unit tests must not need funded accounts, RPC credentials or network access; inject
`rpc`, `fetch` and Sui clients as parameters, as the sibling repo does. Funded execution
must be explicit and approved. Do not claim a funded or deployed flow works on the
strength of mocks, forks or read-only checks. Never commit private keys, environment
files, transaction journals or RPC credentials.

House rule, carried over from the sibling repo: no on-chain ids in markdown. They live in
source constants.
