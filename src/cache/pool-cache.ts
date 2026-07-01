// PoolCache — the fast operational/working layer, separate from PoolStore (the
// durable record). It holds the LIVE state the hot path needs, with atomic
// per-account semantics so it can also be the cross-pod coordination point:
//
//   in-memory cache  -> single pod (in-process mutex for nonce)
//   Redis cache      -> many pods share one working set (atomic INCR / locks)
//
// The cache is NOT the source of truth — PoolStore is. On boot the cache is
// rebuilt from the store; during operation both are written (cache for speed +
// coordination, store for durability). The cache holds only the ACTIVE set; the
// store keeps full history.
//
// DRAFT — interface for review before implementation.

import type { Address } from "../types";
import type { TransactionRecord, AccountRecord } from "../store";

export interface PoolCache {
  // ── nonce lane (the cross-pod coordination primitive) ──────────────────────
  /** Run `fn(nonce)` holding the account's nonce lane: the cursor is allocated
   *  atomically, `fn` runs serialized per account, and the cursor advances ONLY
   *  if `fn` resolves (a throwing `fn` reuses the nonce — no gaps). In-memory this
   *  is an in-process mutex; Redis is a per-account lock, so it serializes the lane
   *  across pods too. */
  withNonce<T>(account: Address, fn: (nonce: number) => Promise<T>): Promise<T>;
  /** Move the cursor forward only (boot reconcile / nonce-drift, from chain truth). */
  seedNonce(account: Address, atLeast: number): Promise<void>;
  /** Current cursor (for state/reporting); undefined if never seeded. */
  peekNonce(account: Address): Promise<number | undefined>;

  // ── in-flight working set (confirm / replace / backpressure) ───────────────
  /** Add or update an in-flight tx (broadcast/replaced). Keyed by account+nonce. */
  putTx(rec: TransactionRecord): Promise<void>;
  /** Remove a settled tx from the active set. */
  dropTx(account: Address, nonce: number): Promise<void>;
  /** Active txs for an account — drives confirmTick. */
  listTxs(account: Address): Promise<TransactionRecord[]>;
  /** Active count for an account — enforces the in-flight cap (backpressure). */
  countTxs(account: Address): Promise<number>;

  // ── per-account gauge (routing / health) ───────────────────────────────────
  /** Update an account's fast-read state (cursor/balance/health). */
  putAccount(rec: AccountRecord): Promise<void>;
  /** Fast snapshot for routing + wallets(). In group mode this reflects ALL pods'
   *  in-flight, so every pod routes on the same picture. */
  listAccounts(ownerId: string, chainId: number): Promise<AccountRecord[]>;

  // ── sticky routing bindings (must be shared so all pods agree per orderingKey) ─
  /** Pin an orderingKey to an account and acquire one ref. If already pinned,
   *  returns the existing account (no migration); else pins `prefer`. Atomic. */
  bindOrdering(ownerId: string, orderingKey: string, prefer: Address): Promise<Address>;
  /** Release one ref for an orderingKey; evict the pin at zero refs. */
  releaseOrdering(ownerId: string, orderingKey: string): Promise<void>;
  /** Active sticky bindings (leak gauge / stats). */
  orderingCount(ownerId: string): Promise<number>;
}
