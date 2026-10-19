-- `log_index` claimed more than the discovery path can know.
--
-- Burns are found through the sibling repo's `findForwarderBurns`, which
-- filters DepositForBurn logs by token and depositor and returns the
-- transaction hash, block and amount -- not the EVM log index. Keeping a
-- column called log_index would mean either inventing the value or
-- reimplementing log decoding here, and the second implementation of a
-- reviewed path is the thing that repository's guide forbids.
--
-- What discovery can know exactly is the position of each of a forwarder's
-- burns within one transaction, in getLogs order, which is stable across
-- rescans and is what makes rediscovery idempotent. That is what this column
-- is, so it says so. For every transaction a crank produces it is 0.
alter table burns
rename column log_index to burn_index;

alter table burns
rename constraint burns_chain_tx_hash_log_index_key to burns_chain_tx_hash_burn_index_key;
