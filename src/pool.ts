// The facade — the only surface a service touches. Owns the account set, wires
// routing, and is the event bus. On every TERMINAL event it releases the sticky
// ref for that ordering key, so the router's sticky map stays bounded.
//
// start()/stop() (the Supervisor that drives confirmTick + balance loops) is still
// TODO; confirmTick itself is implemented and bounded.

import type {
  Address,
  TxRequest,
  SubmitOptions,
  SubmitResult,
  ReattachInput,
  TxEvent,
  TxStatus,
  TxEventRecord,
  WalletState,
} from "./types";
import { txRequestSchema, submitOptionsSchema, reattachInputSchema } from "./types";
import type { WalletPoolConfig } from "./config";
import { ManagedAccount } from "./account";
import { DefaultRouter, LeastInflightSelector, type Router } from "./routing";

const TERMINAL: ReadonlySet<TxStatus> = new Set<TxStatus>([
  "confirmed",
  "reverted",
  "failed",
]);

export interface PoolStats {
  wallets: WalletState[];
  /** Active sticky bindings — watch this for unbounded growth (leak detector). */
  stickyKeys: number;
}

export interface IWalletForcePool {
  start(): void;
  stop(): Promise<void>;
  submit(req: TxRequest, opts: SubmitOptions): Promise<SubmitResult>;
  /** Resolve when this idempotencyKey reaches a terminal state. Resolves on
   *  `confirmed`; rejects on `reverted`/`failed`. Register it right after submit:
   *  it listens for FUTURE events and cannot observe one that already fired. */
  waitForConfirmation(idempotencyKey: string): Promise<TxEventRecord>;
  reattach(tx: ReattachInput): void;
  on(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  off(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  wallets(): WalletState[];
  stats(): PoolStats;
}

export class WalletForcePool implements IWalletForcePool {
  private readonly accounts = new Map<string, ManagedAccount>();
  private readonly router: Router;
  private readonly listeners = new Map<TxEvent, Set<(rec: TxEventRecord) => void>>();
  /** idempotencyKey -> pending waitForConfirmation resolvers. O(1) dispatch, one
   *  small entry per active waiter (vs. registering listeners that scan per event). */
  private readonly waiters = new Map<
    string,
    Array<{ resolve: (r: TxEventRecord) => void; reject: (e: Error) => void }>
  >();

  // Supervisor state — a SINGLE self-scheduling loop drives all accounts (one
  // timer total, never per-account/per-tx), with restart-on-error backoff.
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<void> = Promise.resolve();
  private readonly tickMs: number;
  private errBackoff: number;

  constructor(private readonly config: WalletPoolConfig) {
    const selector = config.selector ?? new LeastInflightSelector();
    this.router = new DefaultRouter(selector);
    this.tickMs = config.confirmTickMs ?? 4_000;
    this.errBackoff = this.tickMs;

    const emit = (rec: TxEventRecord) => this.handleEvent(rec);
    for (const signer of config.signers) {
      this.accounts.set(
        signer.address.toLowerCase(),
        new ManagedAccount({
          signer,
          chainClient: config.chainClient,
          feeOracle: config.feeOracle,
          chainId: config.chainId,
          confirmations: config.confirmations ?? 1,
          stuckAfterMs: config.stuckAfterMs ?? 30_000,
          maxAttempts: config.maxAttempts ?? 5,
          maxInflight: config.maxInflightPerAccount ?? 512,
          emit,
          logger: config.logger,
        }),
      );
    }
  }

  /** Reseed nonces from chain, then start the single confirm/balance loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.prime();
    this.scheduleTick(0);
  }

  /** Stop scheduling and let the in-flight tick finish. Does NOT wait for on-chain
   *  txs to confirm — those stay on-chain; reattach them on the next boot. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.current.catch(() => undefined);
  }

  private scheduleTick(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.current = this.tick();
    }, delayMs);
  }

  /** One supervised pass: confirm every account, refresh balances. Self-reschedules
   *  at the normal cadence on success, or with exponential backoff on an
   *  unexpected error (per-tx errors are already isolated inside confirmTick). */
  private async tick(): Promise<void> {
    if (!this.running) return;
    let delay = this.tickMs;
    try {
      await Promise.allSettled([...this.accounts.values()].map((a) => a.confirmTick()));
      await this.refreshBalances();
      this.errBackoff = this.tickMs; // healthy -> reset backoff
    } catch (err) {
      this.config.logger?.error("walletsforce tick error", err);
      this.errBackoff = Math.min(this.errBackoff * 2, 30_000);
      delay = this.errBackoff;
    }
    this.scheduleTick(delay);
  }

  private async prime(): Promise<void> {
    await Promise.allSettled([...this.accounts.values()].map((a) => a.primeNonce()));
  }

  /** Inline BalanceMonitor: refresh each account's balance + health flag. Below
   *  `minBalanceWei` an account is marked unhealthy (Router drops it from rotation)
   *  and `onLowBalance` fires. */
  private async refreshBalances(): Promise<void> {
    const min = this.config.minBalanceWei;
    await Promise.allSettled(
      [...this.accounts.values()].map(async (a) => {
        const bal = await this.config.chainClient.getBalance(a.address);
        a.setBalance(bal);
        if (min !== undefined) {
          const healthy = bal >= min;
          a.setHealthy(healthy);
          if (!healthy) this.config.onLowBalance?.({ address: a.address, balanceWei: bal });
        }
      }),
    );
  }

  async submit(req: TxRequest, opts: SubmitOptions): Promise<SubmitResult> {
    const r = txRequestSchema.parse(req);
    const o = submitOptionsSchema.parse(opts);
    const address = this.router.route(this.wallets(), r, o);
    const account = this.accounts.get(address.toLowerCase());
    if (!account) throw new Error(`no account for ${address}`);

    const result = await account.submit(r, o);
    this.handleEvent({
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

  /** Promise form of "wait for this tx". Correlates by idempotencyKey, NOT by
   *  hash — the hash changes when a stuck tx is replaced. The listener is removed
   *  on the first terminal event for the key, so it never leaks. */
  waitForConfirmation(idempotencyKey: string): Promise<TxEventRecord> {
    return new Promise<TxEventRecord>((resolve, reject) => {
      const arr = this.waiters.get(idempotencyKey);
      if (arr) arr.push({ resolve, reject });
      else this.waiters.set(idempotencyKey, [{ resolve, reject }]);
    });
  }

  reattach(tx: ReattachInput): void {
    const t = reattachInputSchema.parse(tx);
    const account = this.accounts.get(t.account.toLowerCase());
    if (!account) throw new Error(`no account for ${t.account}`);
    account.reattach(t);
    if (t.orderingKey) this.router.bind(t.orderingKey, t.account);
  }

  on(event: TxEvent, cb: (rec: TxEventRecord) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
  }

  off(event: TxEvent, cb: (rec: TxEventRecord) => void): void {
    this.listeners.get(event)?.delete(cb);
  }

  wallets(): WalletState[] {
    return [...this.accounts.values()].map((a) => a.state());
  }

  stats(): PoolStats {
    return { wallets: this.wallets(), stickyKeys: this.router.size() };
  }

  /** Single sink for every lifecycle event: fan out to subscribers, then release
   *  the sticky ref once an ordered tx reaches a terminal state. */
  private handleEvent(rec: TxEventRecord): void {
    for (const cb of this.listeners.get(rec.status) ?? []) cb(rec);
    if (!TERMINAL.has(rec.status)) return;

    if (rec.orderingKey) this.router.release(rec.orderingKey);

    // Resolve/reject any waitForConfirmation promises for this key, then drop them.
    const arr = this.waiters.get(rec.idempotencyKey);
    if (arr) {
      this.waiters.delete(rec.idempotencyKey);
      for (const w of arr) {
        if (rec.status === "confirmed") w.resolve(rec);
        else w.reject(new Error(`tx ${rec.status}${rec.error ? `: ${rec.error}` : ""} (idempotencyKey=${rec.idempotencyKey})`));
      }
    }
  }
}
