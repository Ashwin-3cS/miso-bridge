-- The durable journal.
--
-- Amounts and block numbers are numeric(78,0): uint256 fits, no JavaScript
-- number does. Hex is stored lowercase and length-checked, because every
-- comparison in this service is byte-exact and a mixed-case duplicate row
-- would be a double mint. Invariants that protect money are expressed here as
-- well as in TypeScript: a wrong deploy must fail, not improvise.

create domain hex32 as text check (value ~ '^0x[0-9a-f]{64}$');
create domain hex20 as text check (value ~ '^0x[0-9a-f]{40}$');
create domain uint256 as numeric(78, 0) check (value >= 0 and scale(value) = 0);

create type network as enum ('mainnet', 'testnet');
create type evm_chain as enum ('avalanche', 'polygon');

-- A Sui recipient, bound to an authenticated user before any address is shown
-- (launch gate 7). Sui does not validate the mint recipient, so this binding
-- is the only thing standing between a user and a mint into the void.
create table recipients (
  sui_address hex32 primary key,
  user_ref text not null,
  bound_at timestamptz not null default now(),
  deny_checked_at timestamptz,
  deny_listed boolean not null default false,
  constraint recipient_nonzero check (
    sui_address <> '0x0000000000000000000000000000000000000000000000000000000000000000'
  )
);

-- One deposit address per recipient per chain per network. The address is
-- derived, never chosen: it is a pure function of the recipient and the
-- forwarder build.
create table deposits (
  id bigserial primary key,
  sui_address hex32 not null references recipients (sui_address),
  network network not null,
  chain evm_chain not null,
  forwarder_address hex20 not null,
  status text not null default 'issued' check (
    status in ('issued', 'fundable', 'cranking', 'cranked', 'waiting')
  ),
  waiting_reason text,
  issued_at timestamptz not null default now(),
  last_balance uint256 not null default 0,
  last_balance_at timestamptz,
  -- While set, the watcher polls this address on the fast loop.
  hot_until timestamptz,
  crank_attempts integer not null default 0,
  last_crank_at timestamptz,
  unique (sui_address, network, chain),
  constraint waiting_has_reason check (
    (status = 'waiting') = (waiting_reason is not null)
  )
);

-- Deposit addresses are identical across chains for a given recipient and
-- build, so this index is the watcher's hot-set scan and the reconciler's
-- "any balance at any address ever issued" sweep.
create index deposits_hot on deposits (network, chain, hot_until)
where
  hot_until is not null;

create index deposits_status on deposits (network, status);

-- One row per DepositForBurn log. Discovered only at the finalized block:
-- Polygon PoS can reorg a burn away, and minting against a reorged burn would
-- mint nothing and corrupt the journal.
create table burns (
  id bigserial primary key,
  deposit_id bigint not null references deposits (id),
  network network not null,
  chain evm_chain not null,
  tx_hash hex32 not null,
  log_index integer not null check (log_index >= 0),
  block_number uint256 not null,
  amount uint256 not null check (amount > 0),
  status text not null default 'discovered' check (
    status in (
      'discovered',
      'attesting',
      'validated',
      'quarantined',
      'minting',
      'minted',
      'reconciled'
    )
  ),
  -- Circle's attester assigns the nonce; it is the exactly-once key for the
  -- mint and the only identifier Sui will agree with.
  nonce hex32 unique,
  message bytea,
  attestation bytea,
  max_fee uint256,
  fee_executed uint256,
  -- Non-null means the attested message is not the burn this forwarder emits.
  -- Such a burn is never minted; it is paged on.
  problem text,
  delay_reason text,
  discovered_at timestamptz not null default now(),
  attested_at timestamptz,
  unique (chain, tx_hash, log_index),
  constraint message_is_a_burn_message check (
    message is null or octet_length(message) >= 376
  ),
  constraint attestation_is_whole_signatures check (
    attestation is null
    or (octet_length(attestation) > 0 and octet_length(attestation) % 65 = 0)
  ),
  constraint attested_has_message check (
    status not in ('validated', 'minting', 'minted', 'reconciled')
    or (
      message is not null
      and attestation is not null
      and nonce is not null
      and problem is null
    )
  ),
  constraint quarantined_has_problem check (
    (status = 'quarantined') = (problem is not null)
  ),
  constraint fee_within_one_percent check (
    max_fee is null or max_fee <= amount / 100
  )
);

create index burns_status on burns (network, status, discovered_at);

create index burns_deposit on burns (deposit_id);

-- One row per nonce, which is what makes the mint exactly-once. The nonce is
-- the primary key rather than a column: a second mint of the same transfer
-- cannot be represented.
create table mints (
  nonce hex32 primary key references burns (nonce),
  burn_id bigint not null unique references burns (id),
  status text not null default 'submitting' check (
    status in ('submitting', 'submitted', 'confirmed')
  ),
  sui_tx_digest text,
  attempts integer not null default 0,
  last_error text,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  constraint confirmed_has_digest check (
    status <> 'confirmed'
    or (sui_tx_digest is not null and confirmed_at is not null)
  )
);

-- A mint may exist only for a burn that validated clean. The check constraints
-- on burns cannot see across rows, and this is the invariant that protects
-- money, so it is a trigger rather than a convention.
create function mints_require_clean_burn () returns trigger language plpgsql as $$
declare
  burn record;
begin
  select status, problem, nonce into burn from burns where id = new.burn_id for share;
  if not found then
    raise exception 'mint references burn % which does not exist', new.burn_id;
  end if;
  if burn.problem is not null then
    raise exception 'mint % would pay a burn with a problem: %', new.nonce, burn.problem;
  end if;
  if burn.nonce is distinct from new.nonce then
    raise exception 'mint nonce % does not match burn nonce %', new.nonce, burn.nonce;
  end if;
  if burn.status not in ('validated', 'minting', 'minted', 'reconciled') then
    raise exception 'mint % would pay a burn in status %', new.nonce, burn.status;
  end if;
  return new;
end $$;

create trigger mints_require_clean_burn before insert
or
update on mints for each row
execute function mints_require_clean_burn ();

-- The same invariant from the other side. The trigger above fires on writes to
-- mints, so it cannot stop a burn that has already minted from being given a
-- problem, moved out of the validated family, or having its nonce or amount
-- rewritten -- each of which would leave a mint attached to a burn this
-- service considers invalid. A burn with a mint is settled history.
create function burns_keep_mints_clean () returns trigger language plpgsql as $$
begin
  if not exists (select 1 from mints where burn_id = new.id) then
    return new;
  end if;
  if new.problem is not null then
    raise exception 'burn % has a mint; it cannot be given a problem: %', new.id, new.problem;
  end if;
  if new.status not in ('validated', 'minting', 'minted', 'reconciled') then
    raise exception 'burn % has a mint; it cannot move to status %', new.id, new.status;
  end if;
  if new.nonce is distinct from old.nonce then
    raise exception 'burn % has a mint; its nonce cannot change', new.id;
  end if;
  if new.amount is distinct from old.amount then
    raise exception 'burn % has a mint; its amount cannot change', new.id;
  end if;
  return new;
end $$;

create trigger burns_keep_mints_clean before
update on burns for each row
execute function burns_keep_mints_clean ();

-- Every state change, with the evidence that caused it. The journal is the
-- only writer; this is what an operator reads after an incident.
create table transitions (
  id bigserial primary key,
  entity text not null check (entity in ('deposit', 'burn', 'mint')),
  entity_key text not null,
  from_status text,
  to_status text not null,
  evidence jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create index transitions_entity on transitions (entity, entity_key, id);

-- Scan progress per worker and chain. Never advanced past the finalized block.
create table cursors (
  name text not null,
  network network not null,
  chain evm_chain not null,
  block_number uint256 not null,
  updated_at timestamptz not null default now(),
  primary key (name, network, chain)
);

-- Open and closed alert state, so a stall pages once and resolves once.
create table alerts (
  id bigserial primary key,
  kind text not null,
  subject text not null,
  network network not null,
  payload jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index alerts_open_once on alerts (kind, subject, network)
where
  closed_at is null;
