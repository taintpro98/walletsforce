// The persistence port. walletsforce write-throughs its recoverable state to a
// PoolStore and rebuilds it via pool.restore() on boot. Default: in-memory (nothing
// durable). Provide a SQL store (see SqliteStore) for crash recovery.

import type { AccountRecord, TransactionRecord } from "./models";

/** Pluggable persistence over the two tables (see ./models). Per-account writes are
 *  already serialized by that account's nonce lane, so implementations need only be
 *  safe across DIFFERENT accounts. */
export interface PoolStore {
  // accounts
  upsertAccount(rec: AccountRecord): Promise<void>;
  loadAccounts(ownerId: string, chainId: number): Promise<AccountRecord[]>;

  // transactions
  /** Upsert by idempotencyKey on broadcast, replace, and every status change. */
  upsertTransaction(rec: TransactionRecord): Promise<void>;
  /** Non-terminal txs for this owner+chain — the set replayed on boot. */
  loadActiveTransactions(ownerId: string, chainId: number): Promise<TransactionRecord[]>;
}
