// Default PoolCache — single-pod, in-process. Holds the operational working set
// in Maps and serializes each account's nonce lane with an in-process promise
// chain. This is "individual mode": pair it with any PoolStore. For "group mode"
// (many pods) swap in a Redis-backed PoolCache that implements the same interface.

import type { Address } from "../types";
import type { TransactionRecord, AccountRecord } from "../store";
import type { PoolCache } from "./pool-cache";

const accountKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

/** Per-account nonce lane: a mutex (promise chain) + cursor that advances only on
 *  success. Mirrors the original NonceLane, minus chain reseeding (the engine calls
 *  seedNonce on boot / nonce-drift). */
class Lane {
  cursor: number | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(seed: number, fn: (nonce: number) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const nonce = this.cursor ?? seed;
      const out = await fn(nonce);
      this.cursor = nonce + 1; // advance only on success
      return out;
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class InMemoryCache implements PoolCache {
  private readonly lanes = new Map<string, Lane>(); // by address
  private readonly txs = new Map<string, Map<number, TransactionRecord>>(); // address -> nonce -> rec
  private readonly accounts = new Map<string, AccountRecord>(); // chainId:address
  private readonly ordering = new Map<string, { account: Address; refs: number }>(); // ownerId\0key

  // ── nonce lane ─────────────────────────────────────────────────────────────
  private lane(address: Address): Lane {
    const key = address.toLowerCase();
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = new Lane();
      this.lanes.set(key, lane);
    }
    return lane;
  }

  async withNonce<T>(account: Address, fn: (nonce: number) => Promise<T>): Promise<T> {
    return this.lane(account).run(0, fn);
  }

  async seedNonce(account: Address, atLeast: number): Promise<void> {
    const lane = this.lane(account);
    lane.cursor = lane.cursor === undefined ? atLeast : Math.max(lane.cursor, atLeast);
  }

  async peekNonce(account: Address): Promise<number | undefined> {
    return this.lanes.get(account.toLowerCase())?.cursor;
  }

  // ── in-flight working set ──────────────────────────────────────────────────
  async putTx(rec: TransactionRecord): Promise<void> {
    const key = rec.account.toLowerCase();
    let lane = this.txs.get(key);
    if (!lane) {
      lane = new Map();
      this.txs.set(key, lane);
    }
    lane.set(rec.nonce, rec);
  }

  async dropTx(account: Address, nonce: number): Promise<void> {
    this.txs.get(account.toLowerCase())?.delete(nonce);
  }

  async listTxs(account: Address): Promise<TransactionRecord[]> {
    const lane = this.txs.get(account.toLowerCase());
    return lane ? [...lane.values()].sort((a, b) => a.nonce - b.nonce) : [];
  }

  async countTxs(account: Address): Promise<number> {
    return this.txs.get(account.toLowerCase())?.size ?? 0;
  }

  // ── account gauges ─────────────────────────────────────────────────────────
  async putAccount(rec: AccountRecord): Promise<void> {
    this.accounts.set(accountKey(rec.chainId, rec.address), rec);
  }

  async listAccounts(ownerId: string, chainId: number): Promise<AccountRecord[]> {
    return [...this.accounts.values()].filter((a) => a.ownerId === ownerId && a.chainId === chainId);
  }

  // ── sticky routing bindings ────────────────────────────────────────────────
  private orderKey(ownerId: string, orderingKey: string) {
    return `${ownerId}:${orderingKey}`;
  }

  async bindOrdering(ownerId: string, orderingKey: string, prefer: Address): Promise<Address> {
    const key = this.orderKey(ownerId, orderingKey);
    const existing = this.ordering.get(key);
    if (existing) {
      existing.refs += 1;
      return existing.account;
    }
    this.ordering.set(key, { account: prefer, refs: 1 });
    return prefer;
  }

  async releaseOrdering(ownerId: string, orderingKey: string): Promise<void> {
    const key = this.orderKey(ownerId, orderingKey);
    const existing = this.ordering.get(key);
    if (!existing) return;
    existing.refs -= 1;
    if (existing.refs <= 0) this.ordering.delete(key);
  }

  async orderingCount(ownerId: string): Promise<number> {
    const prefix = `${ownerId}:`;
    let n = 0;
    for (const key of this.ordering.keys()) if (key.startsWith(prefix)) n += 1;
    return n;
  }
}
