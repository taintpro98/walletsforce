// One per address — the unit of parallelism. Composes a NonceLane with the send
// pipeline (SubmissionEngine) and the confirm/replace loop (ConfirmTracker),
// folded in here for the scaffold.
//
// MEMORY:
//  - `inflight` is bounded: every entry reaches a terminal state and is deleted
//    via settle(). A tx that never mines is retried up to `maxAttempts`, then
//    `failed` and removed — nothing is retained forever.
//  - `pending` (queued + unconfirmed) is capped at `maxInflight`: submit() throws
//    when full, so a fast producer can't grow this account's memory without bound.
//  - the largest per-entry cost is the retained `signable` (incl. calldata),
//    needed to re-sign a same-nonce replacement; released on settle.

import type {
  Address,
  Hash,
  FeeFields,
  TxRequest,
  SubmitOptions,
  SubmitResult,
  ReattachInput,
  WalletState,
  TxStatus,
  TxEventRecord,
  SignableTx,
  Logger,
} from "../types";
import type { Signer } from "../signer";
import type { FeeOracle, FeeContext } from "../fee";
import type { ChainClient } from "../chain";
import { NonceLane } from "./nonce-lane";

export interface ManagedAccountDeps {
  signer: Signer;
  chainClient: ChainClient;
  feeOracle: FeeOracle;
  chainId: number;
  confirmations: number;
  stuckAfterMs: number;
  maxAttempts: number;
  /** Cap on queued + unconfirmed txs; submit() throws above it. */
  maxInflight: number;
  /** Lifecycle sink — the pool fans these out + releases sticky refs + waiters. */
  emit: (rec: TxEventRecord) => void;
  logger?: Logger;
}

interface InflightEntry {
  signable: SignableTx; // full tx so a replacement re-signs the SAME nonce with bumped fees
  hash: Hash;
  attempts: number;
  submittedAt: number;
  minedEmitted: boolean;
  idempotencyKey: string;
  orderingKey?: string;
  metadata?: Record<string, unknown>;
  /** false for reattached txs: their `signable` is a placeholder (no calldata), so
   *  they can be tracked/confirmed but NOT autonomously replaced. */
  replaceable: boolean;
}

export class ManagedAccount {
  readonly address: Address;
  private readonly lane: NonceLane;
  private readonly inflight = new Map<number, InflightEntry>();
  /** queued + unconfirmed; the value the cap is enforced against. */
  private pending = 0;
  private balanceWei = 0n;
  private healthy = true;

  constructor(private readonly deps: ManagedAccountDeps) {
    this.address = deps.signer.address;
    this.lane = new NonceLane(this.address, deps.chainClient);
  }

  /** Allocate a nonce, build + sign + broadcast. Resolves on broadcast. Throws
   *  when the account is at its in-flight cap (backpressure). */
  async submit(req: TxRequest, opts: SubmitOptions): Promise<SubmitResult> {
    if (this.pending >= this.deps.maxInflight) {
      throw new Error(
        `account ${this.address} at in-flight cap (${this.deps.maxInflight})`,
      );
    }
    this.pending++;
    try {
      return await this.lane.withNextNonce(async (nonce) => {
        const fees = await this.deps.feeOracle.estimate(this.feeCtx(0));
        const gas =
          req.gasLimit ??
          (await this.deps.chainClient.estimateGas(this.buildSignable(req, nonce, fees, 0n)));
        const signable = this.buildSignable(req, nonce, fees, gas);
        const raw = await this.deps.signer.signTransaction(signable);
        const hash = await this.deps.chainClient.sendRawTransaction(raw);

        this.inflight.set(nonce, {
          signable,
          hash,
          attempts: 1,
          submittedAt: Date.now(),
          minedEmitted: false,
          idempotencyKey: opts.idempotencyKey,
          orderingKey: opts.orderingKey,
          metadata: opts.metadata,
          replaceable: true, // we hold the full signed tx, so we can re-sign it
        });

        return { account: this.address, nonce, hash, fees };
      });
    } catch (err) {
      this.pending = Math.max(0, this.pending - 1); // broadcast failed; no entry retained
      throw err;
    }
  }

  /** Resume tracking a previously-broadcast tx after a restart. Not capped (boot
   *  restore must succeed). NOTE: the placeholder `signable` has no calldata, so a
   *  reattached tx can be confirmed but not autonomously replaced — pass the full
   *  tx here later if post-restart replacement is needed. */
  reattach(tx: ReattachInput): void {
    this.pending++;
    this.inflight.set(tx.nonce, {
      signable: {
        chainId: this.deps.chainId,
        nonce: tx.nonce,
        to: "0x0000000000000000000000000000000000000000" as Address,
        gas: 0n,
        fees: tx.fees,
      },
      hash: tx.hash,
      attempts: 1,
      submittedAt: Date.now(),
      minedEmitted: false,
      idempotencyKey: tx.idempotencyKey,
      orderingKey: tx.orderingKey,
      metadata: tx.metadata,
      replaceable: false, // placeholder signable (no calldata) — never re-sign it
    });
    this.lane.reseed(tx.nonce + 1);
  }

  /** One pass over in-flight txs: confirm / detect revert / bump-and-replace /
   *  give up. settle() deletes the entry and frees its slot so memory stays
   *  bounded. Per-entry errors are isolated. */
  async confirmTick(): Promise<void> {
    if (this.inflight.size === 0) return;
    let head: bigint | null = null;

    for (const [nonce, entry] of [...this.inflight.entries()]) {
      try {
        const receipt = await this.deps.chainClient.getTransactionReceipt(entry.hash);

        if (receipt) {
          if (receipt.status === "reverted") {
            this.settle(nonce, entry, "reverted");
            continue;
          }
          if (head === null) head = await this.deps.chainClient.getBlockNumber();
          const confirmations = head - receipt.blockNumber + 1n;
          if (confirmations < BigInt(this.deps.confirmations)) {
            if (!entry.minedEmitted) {
              entry.minedEmitted = true;
              this.emit(entry, "mined");
            }
            continue;
          }
          this.settle(nonce, entry, "confirmed");
          continue;
        }

        if (Date.now() - entry.submittedAt >= this.deps.stuckAfterMs) {
          if (!entry.replaceable) {
            // Reattached tx: we lack the calldata to re-sign it, so we cannot bump
            // it. Keep polling its original hash — broadcasting the placeholder would
            // send a garbage tx and loop forever. (Re-broadcast it yourself if needed.)
            continue;
          }
          if (entry.attempts >= this.deps.maxAttempts) {
            this.settle(nonce, entry, "failed", `unmined after ${entry.attempts} attempts`);
            continue;
          }
          await this.replace(entry);
        }
      } catch (err) {
        const cls = this.deps.chainClient.classifyError(err);
        const msg = err instanceof Error ? err.message : String(err);
        if (cls === "transient") {
          this.deps.logger?.warn(`confirm transient error nonce=${nonce}`, msg);
        } else {
          this.deps.logger?.error(`confirm error nonce=${nonce}`, msg);
        }
        // leave the entry; next tick retries.
      }
    }
  }

  /** Boot reconciliation: seed the nonce cursor from chain truth. Best-effort —
   *  the lane also seeds lazily on first submit, so a failure here is non-fatal. */
  async primeNonce(): Promise<void> {
    const n = await this.deps.chainClient.getTransactionCount(this.address, "pending");
    this.lane.reseed(n);
  }

  state(): WalletState {
    return {
      address: this.address,
      inflightCount: this.inflight.size,
      nonceCursor: this.lane.nextNonce ?? 0,
      balanceWei: this.balanceWei,
      healthy: this.healthy,
    };
  }

  setBalance(wei: bigint): void {
    this.balanceWei = wei;
  }

  setHealthy(h: boolean): void {
    this.healthy = h;
  }

  /** Terminal: drop the entry (frees its slot + retained calldata), free the cap
   *  slot, and emit. The single place in-flight memory is released. */
  private settle(nonce: number, entry: InflightEntry, status: TxStatus, error?: string): void {
    this.inflight.delete(nonce);
    this.pending = Math.max(0, this.pending - 1);
    this.emit(entry, status, error);
  }

  /** Re-sign the SAME nonce with bumped fees. A nonce-drift on send means the
   *  original already landed — keep the old hash so the next tick confirms it. */
  private async replace(entry: InflightEntry): Promise<void> {
    const fees = await this.deps.feeOracle.bump(entry.signable.fees, this.feeCtx(entry.attempts));
    const signable: SignableTx = { ...entry.signable, fees };
    let hash: Hash;
    try {
      const raw = await this.deps.signer.signTransaction(signable);
      hash = await this.deps.chainClient.sendRawTransaction(raw);
    } catch (err) {
      if (this.deps.chainClient.classifyError(err) === "nonce-drift") return;
      throw err;
    }
    entry.signable = signable;
    entry.hash = hash;
    entry.attempts += 1;
    entry.submittedAt = Date.now();
    this.emit(entry, "replaced");
  }

  private emit(entry: InflightEntry, status: TxStatus, error?: string): void {
    this.deps.emit({
      idempotencyKey: entry.idempotencyKey,
      orderingKey: entry.orderingKey,
      account: this.address,
      nonce: entry.signable.nonce,
      hash: entry.hash,
      fees: entry.signable.fees,
      status,
      attempts: entry.attempts,
      metadata: entry.metadata,
      error,
      at: Date.now(),
    });
  }

  private feeCtx(attempt: number): FeeContext {
    return { chainId: this.deps.chainId, attempt, client: this.deps.chainClient };
  }

  private buildSignable(
    req: TxRequest,
    nonce: number,
    fees: FeeFields,
    gas: bigint,
  ): SignableTx {
    return {
      chainId: this.deps.chainId,
      nonce,
      to: req.to,
      data: req.data,
      value: req.value,
      gas,
      fees,
    };
  }
}
