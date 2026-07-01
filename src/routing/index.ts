// Routing: pick the account for each request and enforce single-writer.
//   orderingKey present -> sticky account (FIFO within the key)
//   otherwise           -> Selector.pick (default: least-inflight)
//
// Sticky bindings are ref-counted against active work so the sticky map stays
// bounded — a key with no in-flight/queued txs is evicted (no unbounded growth
// even when orderingKey cardinality is unbounded, e.g. per-sender keys).

import type { Address, TxRequest, SubmitOptions, WalletState } from "../types";

/** Picks an account for an UNORDERED request among healthy candidates. */
export interface WalletSelector {
  pick(candidates: WalletState[], req: TxRequest): Address;
}

export interface Router {
  /** Choose (and, for ordered keys, acquire a ref to) an account. Async because the
   *  sticky bindings live in the PoolCache (shared across pods in group mode). */
  route(candidates: WalletState[], req: TxRequest, opts: SubmitOptions): Promise<Address>;
  /** Re-pin + acquire a ref for a reattached/restored tx on boot. */
  bind(orderingKey: string, account: Address): Promise<void>;
  /** Release one ref for an ordering key; evict the binding at zero. */
  release(orderingKey: string): Promise<void>;
  /** Current number of sticky bindings — for leak observability. */
  size(): Promise<number>;
}

export * from "./least-inflight.selector";
export * from "./default-router";
