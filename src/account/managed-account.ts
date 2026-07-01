// One per address — the unit of parallelism. Operates on two pluggable layers:
//   PoolCache  — fast working set: nonce lane, in-flight txs, account gauge.
//   PoolStore  — durable record (write-ahead + history) for crash recovery.
// No operational state lives in this object anymore; it's all in the cache (so a
// shared/Redis cache makes many pods coordinate). The store is written store-first
// for durability; the cache holds the live working set the hot path reads.

import type {
  Address,
  Hash,
  FeeFields,
  TxRequest,
  SubmitOptions,
  SubmitResult,
  ReattachInput,
  TxStatus,
  TxEvent,
  TerminalStatus,
  TxEventRecord,
  SignableTx,
  Logger,
} from "../types";
import type { Signer } from "../signer";
import type { FeeOracle, FeeContext } from "../fee";
import type { ChainClient } from "../chain";
import type { PoolStore, TransactionRecord, AccountRecord } from "../store";
import type { PoolCache } from "../cache";

const ZERO_HASH = ("0x" + "0".repeat(64)) as Hash;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ManagedAccountDeps {
  signer: Signer;
  chainClient: ChainClient;
  feeOracle: FeeOracle;
  chainId: number;
  ownerId: string;
  confirmations: number;
  stuckAfterMs: number;
  maxAttempts: number;
  /** Cap on in-flight txs for this account; submit() throws above it. */
  maxInflight: number;
  /** Lifecycle sink — the pool fans these out + releases sticky refs + waiters. */
  emit: (rec: TxEventRecord) => void;
  /** Fast working set (nonce lane, in-flight, gauge). */
  cache: PoolCache;
  /** Durable record (write-ahead + history). */
  store: PoolStore;
  logger?: Logger;
}

export class ManagedAccount {
  readonly address: Address;

  constructor(private readonly deps: ManagedAccountDeps) {
    this.address = deps.signer.address;
  }

  /** Allocate a nonce (cache lane), write-ahead to the store, broadcast, then record
   *  the broadcast in store (durable) + cache (operational). Resolves on broadcast. */
  async submit(req: TxRequest, opts: SubmitOptions): Promise<SubmitResult> {
    return this.deps.cache.withNonce(this.address, async (nonce) => {
      // Backpressure — checked inside the lane, so the count is accurate per account.
      if ((await this.deps.cache.countTxs(this.address)) >= this.deps.maxInflight) {
        throw new Error(`account ${this.address} at in-flight cap (${this.deps.maxInflight})`);
      }
      const fees = await this.deps.feeOracle.estimate(this.feeCtx(0));
      const gas =
        req.gasLimit ??
        (await this.deps.chainClient.estimateGas(this.buildSignable(req, nonce, fees, 0n)));
      const signable = this.buildSignable(req, nonce, fees, gas);
      const rec = this.newRecord(nonce, signable, ZERO_HASH, "pending", opts);

      // WRITE-AHEAD: durably record intent before broadcasting (awaited; fatal).
      await this.deps.store.upsertTransaction(rec);

      let hash: Hash;
      try {
        const raw = await this.deps.signer.signTransaction(signable);
        hash = await this.deps.chainClient.sendRawTransaction(raw);
      } catch (err) {
        // Never entered the mempool — drop the write-ahead row; reseed on nonce-drift.
        await this.deps.store
          .upsertTransaction({ ...rec, status: "failed", error: msg(err), updatedAt: Date.now() })
          .catch(() => undefined);
        await this.reseedOnDrift(err, nonce);
        throw err;
      }

      const live: TransactionRecord = { ...rec, hash, status: "broadcast", updatedAt: Date.now() };
      await this.deps.store.upsertTransaction(live); // store-first (durable)
      await this.deps.cache.putTx(live); // operational (now tracked by confirmTick)
      return { account: this.address, nonce, hash, fees };
    });
  }

  /** Resume tracking a previously-broadcast tx (manual escape hatch). Placeholder
   *  signable (no calldata) -> confirm-only, never replaced. Store-first. */
  async reattach(tx: ReattachInput): Promise<void> {
    const rec: TransactionRecord = {
      idempotencyKey: tx.idempotencyKey,
      ownerId: this.deps.ownerId,
      chainId: this.deps.chainId,
      account: this.address.toLowerCase() as Address,
      nonce: tx.nonce,
      to: "0x0000000000000000000000000000000000000000" as Address,
      gas: 0n,
      fees: tx.fees,
      hash: tx.hash,
      status: "broadcast",
      attempts: 1,
      submittedAt: Date.now(),
      minedEmitted: false,
      orderingKey: tx.orderingKey,
      metadata: tx.metadata,
      replaceable: false,
      updatedAt: Date.now(),
    };
    await this.deps.store.upsertTransaction(rec);
    await this.deps.cache.putTx(rec);
    await this.deps.cache.seedNonce(this.address, tx.nonce + 1);
  }

  /** One pass over the account's in-flight txs (from the cache): confirm / revert /
   *  bump-and-replace / give up. Every transition is store-first then cache. */
  async confirmTick(): Promise<void> {
    const txs = await this.deps.cache.listTxs(this.address);
    if (txs.length === 0) return;
    let head: bigint | null = null;

    for (const rec of txs) {
      try {
        const receipt = await this.deps.chainClient.getTransactionReceipt(rec.hash);

        if (receipt) {
          if (receipt.status === "reverted") {
            await this.settle(rec, "reverted");
            continue;
          }
          if (head === null) head = await this.deps.chainClient.getBlockNumber();
          if (head - receipt.blockNumber + 1n < BigInt(this.deps.confirmations)) {
            if (!rec.minedEmitted) {
              const mined: TransactionRecord = { ...rec, minedEmitted: true, status: "mined", updatedAt: Date.now() };
              await this.deps.store.upsertTransaction(mined);
              await this.deps.cache.putTx(mined);
              this.notify(mined, "mined");
            }
            continue;
          }
          await this.settle(rec, "confirmed");
          continue;
        }

        if (Date.now() - rec.submittedAt >= this.deps.stuckAfterMs) {
          if (rec.replaceable === false) continue; // reattached placeholder — keep polling
          if (rec.attempts >= this.deps.maxAttempts) {
            await this.settle(rec, "failed", `unmined after ${rec.attempts} attempts`);
            continue;
          }
          await this.replace(rec);
        }
      } catch (err) {
        const cls = this.deps.chainClient.classifyError(err);
        if (cls === "transient") this.deps.logger?.warn(`confirm transient nonce=${rec.nonce}`, msg(err));
        else this.deps.logger?.error(`confirm error nonce=${rec.nonce}`, msg(err));
      }
    }
  }

  /** Boot reconciliation: seed the lane cursor from chain truth. */
  async primeNonce(): Promise<void> {
    const n = await this.deps.chainClient.getTransactionCount(this.address, "pending");
    await this.deps.cache.seedNonce(this.address, n);
  }

  /** Refresh balance/health and persist (store + cache). */
  async refreshState(balanceWei: bigint, healthy: boolean): Promise<void> {
    const rec = await this.accountRecord(balanceWei, healthy);
    await this.deps.store.upsertAccount(rec);
    await this.deps.cache.putAccount(rec);
  }

  /** Seed a fresh account row (no prior persisted state) into store + cache. */
  async seed(): Promise<void> {
    const rec = await this.accountRecord(0n, true);
    await this.deps.store.upsertAccount(rec);
    await this.deps.cache.putAccount(rec);
  }

  /** Boot: rebuild cache lane/gauge from a persisted account row. */
  async restoreAccountState(rec: AccountRecord): Promise<void> {
    await this.deps.cache.seedNonce(this.address, rec.nonceCursor);
    await this.deps.cache.putAccount(rec);
  }

  /** Boot: re-track a persisted in-flight tx in the cache + reseed the lane. */
  async restoreTransaction(rec: TransactionRecord): Promise<void> {
    await this.deps.cache.putTx(rec);
    await this.deps.cache.seedNonce(this.address, rec.nonce + 1);
  }

  /** Re-send a write-ahead ("pending") tx on boot. Idempotent (deterministic re-sign). */
  async rebroadcast(nonce: number): Promise<void> {
    const rec = (await this.deps.cache.listTxs(this.address)).find((t) => t.nonce === nonce);
    if (!rec) return;
    try {
      const raw = await this.deps.signer.signTransaction(this.signableOf(rec));
      const hash = await this.deps.chainClient.sendRawTransaction(raw);
      const live = { ...rec, hash, status: "broadcast" as TxStatus, updatedAt: Date.now() };
      await this.deps.store.upsertTransaction(live);
      await this.deps.cache.putTx(live);
    } catch (err) {
      if (this.deps.chainClient.classifyError(err) === "nonce-drift") {
        const live = { ...rec, status: "broadcast" as TxStatus, updatedAt: Date.now() };
        await this.deps.store.upsertTransaction(live);
        await this.deps.cache.putTx(live);
        return;
      }
      this.deps.logger?.error(`rebroadcast failed nonce=${nonce}`, msg(err));
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Terminal: persist the terminal row (store-first; throws -> retried), then drop
   *  it from the cache and notify. Store and cache never disagree. */
  private async settle(rec: TransactionRecord, status: TerminalStatus, error?: string): Promise<void> {
    const terminal: TransactionRecord = { ...rec, status, error, updatedAt: Date.now() };
    await this.deps.store.upsertTransaction(terminal);
    await this.deps.cache.dropTx(this.address, rec.nonce);
    this.notify(terminal, status, error);
  }

  /** Re-sign the SAME nonce with bumped fees; store-first, then cache + notify. */
  private async replace(rec: TransactionRecord): Promise<void> {
    const fees = await this.deps.feeOracle.bump(rec.fees, this.feeCtx(rec.attempts));
    const signable: SignableTx = { ...this.signableOf(rec), fees };
    let hash: Hash;
    try {
      const raw = await this.deps.signer.signTransaction(signable);
      hash = await this.deps.chainClient.sendRawTransaction(raw);
    } catch (err) {
      if (this.deps.chainClient.classifyError(err) === "nonce-drift") return;
      throw err;
    }
    const updated: TransactionRecord = {
      ...rec,
      fees,
      hash,
      status: "broadcast",
      attempts: rec.attempts + 1,
      submittedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.deps.store.upsertTransaction(updated);
    await this.deps.cache.putTx(updated);
    this.notify(updated, "replaced");
  }

  private async reseedOnDrift(err: unknown, nonce: number): Promise<void> {
    if (this.deps.chainClient.classifyError(err) !== "nonce-drift") return;
    const chainNonce = await this.deps.chainClient
      .getTransactionCount(this.address, "pending")
      .catch(() => 0);
    await this.deps.cache.seedNonce(this.address, Math.max(chainNonce, nonce + 1));
  }

  private notify(rec: TransactionRecord, status: TxEvent, error?: string): void {
    this.deps.emit({
      idempotencyKey: rec.idempotencyKey,
      orderingKey: rec.orderingKey,
      account: this.address,
      nonce: rec.nonce,
      hash: rec.hash,
      fees: rec.fees,
      status,
      attempts: rec.attempts,
      metadata: rec.metadata,
      error,
      at: Date.now(),
    });
  }

  private newRecord(
    nonce: number,
    signable: SignableTx,
    hash: Hash,
    status: TxStatus,
    opts: SubmitOptions,
  ): TransactionRecord {
    return {
      idempotencyKey: opts.idempotencyKey,
      ownerId: this.deps.ownerId,
      chainId: this.deps.chainId,
      account: this.address.toLowerCase() as Address,
      nonce,
      to: signable.to,
      data: signable.data,
      value: signable.value,
      gas: signable.gas,
      fees: signable.fees,
      hash,
      status,
      attempts: 1,
      submittedAt: Date.now(),
      minedEmitted: false,
      orderingKey: opts.orderingKey,
      metadata: opts.metadata,
      replaceable: true,
      updatedAt: Date.now(),
    };
  }

  private signableOf(rec: TransactionRecord): SignableTx {
    return {
      chainId: rec.chainId,
      nonce: rec.nonce,
      to: rec.to,
      data: rec.data,
      value: rec.value,
      gas: rec.gas,
      fees: rec.fees,
    };
  }

  private async accountRecord(balanceWei: bigint, healthy: boolean): Promise<AccountRecord> {
    const derivationIndex = (this.deps.signer as { derivationIndex?: number }).derivationIndex;
    return {
      ownerId: this.deps.ownerId,
      chainId: this.deps.chainId,
      address: this.address.toLowerCase() as Address,
      derivationIndex,
      nonceCursor: (await this.deps.cache.peekNonce(this.address)) ?? 0,
      balanceWei,
      healthy,
      updatedAt: Date.now(),
    };
  }

  private feeCtx(attempt: number): FeeContext {
    return { chainId: this.deps.chainId, attempt, client: this.deps.chainClient };
  }

  private buildSignable(req: TxRequest, nonce: number, fees: FeeFields, gas: bigint): SignableTx {
    return { chainId: this.deps.chainId, nonce, to: req.to, data: req.data, value: req.value, gas, fees };
  }
}
