// The reconciler — the periodic control loop, a peer of the pool (not derived from
// it). Constructed from a SupervisorConfig (the tick cadence + balance/refill knobs
// the pool never needs — funder, minBalanceWei) plus the SHARED substrate, it ticks
// over the substrate's account set (the same objects the pool submits through) — driving confirmTick
// (confirm / replace / give up) plus a balance refresh/refill pass, persisting
// results through the account (store + cache).
//
// A SINGLE self-scheduling loop (one timer total) with restart-on-error backoff.
// The CALLER constructs it — `new Supervisor(config)` — and starts it. Run it in
// exactly one place per account set: the same process that submits (individual),
// or a dedicated pod / leader (group) that builds ONLY a Supervisor, so N submitter
// pods never tick in parallel.

import type { Address, Logger } from "./types";
import type { ChainClient } from "./chain";
import type { Funder } from "./balance";
import type { SupervisorConfig } from "./config";
import type { ManagedAccount } from "./account";
import type { Substrate } from "./substrate";

export class Supervisor {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<void> = Promise.resolve();
  private errBackoff: number;

  private readonly accounts: ManagedAccount[];
  private readonly chainClient: ChainClient;
  private readonly tickMs: number;
  private readonly minBalanceWei?: bigint;
  private readonly onLowBalance?: (w: { address: Address; balanceWei: bigint }) => void;
  private readonly logger?: Logger;

  /** @param substrate the shared runtime — the SAME object passed to the pool in
   *  single-pod. We tick over ITS account set (not a rebuilt copy), and confirmations
   *  emit into its bus, so a submit-side waiter resolves when we confirm. Required.
   *  @param funder optional auto-refill service. Injected, not config: it's a
   *  caller-owned object (holds a treasury signer, does I/O). When set, each tick
   *  calls `funder.maybeTopUp(addr)` for every account below `minBalanceWei`. */
  constructor(
    config: SupervisorConfig,
    substrate: Substrate,
    private readonly funder?: Funder,
  ) {
    // Tick over the shared account set — one set of ManagedAccount objects, not a copy.
    this.accounts = [...substrate.accounts.values()];
    this.chainClient = config.chainClient;
    this.tickMs = config.confirmTickMs ?? 4_000;
    this.minBalanceWei = config.minBalanceWei;
    this.onLowBalance = config.onLowBalance;
    this.logger = config.logger;
    this.errBackoff = this.tickMs;
  }

  /** Reseed nonces from chain, then start the single confirm/balance loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.prime();
    this.scheduleTick(0);
  }

  /** Stop scheduling and let the in-flight tick finish. On-chain txs stay on-chain;
   *  the next boot reconciles them via restore(). */
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
   *  at the normal cadence, or with exponential backoff on an unexpected error
   *  (per-tx errors are already isolated inside confirmTick). */
  private async tick(): Promise<void> {
    if (!this.running) return;
    let delay = this.tickMs;
    try {
      await Promise.allSettled(this.accounts.map((a) => a.confirmTick()));
      await this.refreshBalances();
      this.errBackoff = this.tickMs; // healthy -> reset backoff
    } catch (err) {
      this.logger?.error("walletsforce supervisor tick error", err);
      this.errBackoff = Math.min(this.errBackoff * 2, 30_000);
      delay = this.errBackoff;
    }
    this.scheduleTick(delay);
  }

  private async prime(): Promise<void> {
    await Promise.allSettled(this.accounts.map((a) => a.primeNonce()));
  }

  /** Refresh each account's balance + health. Below `minBalanceWei` an account is
   *  marked unhealthy (routing drops it) and `onLowBalance`/`funder` fire. */
  private async refreshBalances(): Promise<void> {
    const min = this.minBalanceWei;
    await Promise.allSettled(
      this.accounts.map(async (a) => {
        const bal = await this.chainClient.getBalance(a.address);
        const healthy = min === undefined ? true : bal >= min;
        if (min !== undefined && !healthy) {
          this.onLowBalance?.({ address: a.address, balanceWei: bal });
          await this.funder?.maybeTopUp(a.address).catch((err) =>
            this.logger?.error("funder.maybeTopUp failed", err),
          );
        }
        await a.refreshState(bal, healthy).catch((err) =>
          this.logger?.error("refreshState failed", err),
        );
      }),
    );
  }
}
