// The facade — the submit surface a service touches. Owns its account set, wires
// routing, and is the entry point for submit / reattach / restore. It does NOT run
// the reconciler loop: that's the Supervisor, constructed independently from the
// same config. Both share the cache + store + event bus (the substrate), so the
// pool submits and the supervisor confirms over one working set.
//
// Lifecycle events (on / waitForConfirmation) go through the shared EventBus, so a
// waiter registered here resolves when the supervisor confirms the tx.

import type {
  Address,
  TxRequest,
  SubmitOptions,
  SubmitResult,
  ReattachInput,
  TxEvent,
  TxEventRecord,
  WalletState,
} from "./types";
import { txRequestSchema, submitOptionsSchema, reattachInputSchema } from "./types";
import type { WalletPoolConfig } from "./config";
import type { ManagedAccount } from "./account";
import { DefaultRouter, LeastInflightSelector, type Router } from "./routing";
import type { PoolStore } from "./store";
import type { PoolCache } from "./cache";
import type { EventBus, WaitOptions } from "./events";
import type { Substrate } from "./substrate";

export interface PoolStats {
  wallets: WalletState[];
  /** Active sticky bindings — watch this for unbounded growth (leak detector). */
  stickyKeys: number;
}

export interface IWalletForcePool {
  /** Boot reconcile — rebuild cache/in-flight state from the store. Alias for
   *  restore(); the pool has no loop, so this is the whole "start". Returns the
   *  number of transactions restored. */
  start(): Promise<number>;
  /** Graceful stop. The pool is reactive (no timer) and every write is awaited, so
   *  there is nothing to flush — provided for a symmetric lifecycle. Idempotent. */
  stop(): Promise<void>;
  submit(req: TxRequest, opts: SubmitOptions): Promise<SubmitResult>;
  /** Resolve when this idempotencyKey reaches a terminal state. Resolves on
   *  `confirmed`; rejects on `reverted`/`failed`. Register it right after submit:
   *  it listens for FUTURE events and cannot observe one that already fired. */
  waitForConfirmation(idempotencyKey: string, opts?: WaitOptions): Promise<TxEventRecord>;
  reattach(tx: ReattachInput): Promise<void>;
  /** Rebuild in-flight state from the configured store. Call once on boot, BEFORE
   *  submitting new work. Returns how many transactions were restored. */
  restore(): Promise<number>;
  on(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  off(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  /** Per-account state read from the cache (the live operational view). */
  wallets(): Promise<WalletState[]>;
  stats(): Promise<PoolStats>;
}

export class WalletForcePool implements IWalletForcePool {
  private readonly accounts: Map<string, ManagedAccount>;
  private readonly router: Router;
  private readonly store: PoolStore;
  private readonly cache: PoolCache;
  private readonly bus: EventBus;

  /** @param substrate the shared runtime — cache, store, bus, AND the account set —
   *  built ONCE with `createSubstrate(config)` (or your own Redis/SQL backends) and
   *  passed to BOTH the pool and the supervisor. Required: there is no per-instance
   *  default, and the account set is shared, not rebuilt, so nothing can diverge. */
  constructor(
    private readonly config: WalletPoolConfig,
    substrate: Substrate,
  ) {
    const selector = config.selector ?? new LeastInflightSelector();
    this.cache = substrate.cache;
    this.store = substrate.store;
    this.bus = substrate.bus;
    this.accounts = substrate.accounts;
    this.router = new DefaultRouter(selector, this.cache, config.ownerId);
  }

  async start(): Promise<number> {
    return this.restore();
  }

  stop(): Promise<void> {
    // No timer, and every store/cache write completes before submit()/settle()
    // resolves, so there is nothing to flush. Present for lifecycle symmetry.
    return Promise.resolve();
  }

  async submit(req: TxRequest, opts: SubmitOptions): Promise<SubmitResult> {
    const r = txRequestSchema.parse(req);
    const o = submitOptionsSchema.parse(opts);
    const address = await this.router.route(await this.walletStates(), r, o);
    const account = this.accounts.get(address.toLowerCase());
    // route() acquired a sticky ref for ordered keys; if the submit never reaches a
    // terminal event (no account / broadcast failure / backpressure), release it
    // here so the sticky set stays bounded. Otherwise failed ordered submits leak.
    if (!account) {
      if (o.orderingKey) await this.router.release(o.orderingKey).catch(() => undefined);
      throw new Error(`no account for ${address}`);
    }

    let result: SubmitResult;
    try {
      result = await account.submit(r, o);
    } catch (err) {
      if (o.orderingKey) await this.router.release(o.orderingKey).catch(() => undefined);
      throw err;
    }
    this.bus.handle({
      idempotencyKey: o.idempotencyKey,
      orderingKey: o.orderingKey,
      account: result.account,
      nonce: result.nonce,
      hash: result.hash,
      fees: result.fees,
      status: "broadcast",
      attempts: 1,
      metadata: o.metadata,
      at: Date.now(),
    });
    return result;
  }

  /** Promise form of "wait for this tx" — delegates to the shared bus. Correlates
   *  by idempotencyKey, NOT hash (the hash changes when a stuck tx is replaced).
   *  Pass `{ timeoutMs }` to bound the wait (a key that never settles hangs forever). */
  waitForConfirmation(idempotencyKey: string, opts?: WaitOptions): Promise<TxEventRecord> {
    return this.bus.waitForConfirmation(idempotencyKey, opts);
  }

  async reattach(tx: ReattachInput): Promise<void> {
    const t = reattachInputSchema.parse(tx);
    const account = this.accounts.get(t.account.toLowerCase());
    if (!account) throw new Error(`no account for ${t.account}`);
    await account.reattach(t);
    if (t.orderingKey) await this.router.bind(t.orderingKey, t.account);
  }

  async restore(): Promise<number> {
    const { ownerId, chainId } = this.config;
    // Reconcile each owned account with the store into the cache: hydrate from a
    // persisted row if one exists, else seed a fresh one so the full pool is present.
    const stored = await this.store.loadAccounts(ownerId, chainId);
    const byAddr = new Map(stored.map((r) => [r.address.toLowerCase(), r]));
    for (const [addr, account] of this.accounts) {
      const rec = byAddr.get(addr);
      if (rec) await account.restoreAccountState(rec);
      else await account.seed();
    }
    // Re-track in-flight txs from the store into the cache; rebroadcast any
    // write-ahead ("pending") rows that may not have reached the mempool.
    const txs = await this.store.loadActiveTransactions(ownerId, chainId);
    const rebroadcasts: Promise<void>[] = [];
    for (const rec of txs) {
      const account = this.accounts.get(rec.account.toLowerCase());
      if (!account) continue; // a tx for an account this instance no longer owns
      await account.restoreTransaction(rec);
      if (rec.orderingKey) await this.router.bind(rec.orderingKey, rec.account); // rebuild sticky binding
      if (rec.status === "pending") rebroadcasts.push(account.rebroadcast(rec.nonce));
    }
    await Promise.allSettled(rebroadcasts);
    return txs.length;
  }

  on(event: TxEvent, cb: (rec: TxEventRecord) => void): void {
    this.bus.on(event, cb);
  }

  off(event: TxEvent, cb: (rec: TxEventRecord) => void): void {
    this.bus.off(event, cb);
  }

  /** Per-account state, read from the cache (the live operational view; in group
   *  mode it reflects ALL pods). Iterates the OWNED account set, so routing always
   *  has candidates even before the cache is seeded. Also the public wallets(). */
  async wallets(): Promise<WalletState[]> {
    return this.walletStates();
  }

  async stats(): Promise<PoolStats> {
    return { wallets: await this.walletStates(), stickyKeys: await this.router.size() };
  }

  private async walletStates(): Promise<WalletState[]> {
    const { ownerId, chainId } = this.config;
    const gauges = await this.cache.listAccounts(ownerId, chainId);
    const byAddr = new Map(gauges.map((a) => [a.address.toLowerCase(), a]));
    return Promise.all(
      [...this.accounts.keys()].map(async (addr) => {
        const a = byAddr.get(addr);
        return {
          address: (a?.address ?? addr) as Address,
          inflightCount: await this.cache.countTxs(addr as Address),
          // the lane cursor is the live value; the gauge's is a snapshot
          nonceCursor: (await this.cache.peekNonce(addr as Address)) ?? a?.nonceCursor ?? 0,
          balanceWei: a?.balanceWei ?? 0n,
          healthy: a?.healthy ?? true, // default healthy until first gauge
        };
      }),
    );
  }
}
