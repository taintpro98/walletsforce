import type { Address, TxRequest, SubmitOptions, WalletState } from "../types";
import type { Router, WalletSelector } from "./index";
import type { PoolCache } from "../cache";

/** Sticky-by-orderingKey router whose bindings live in the PoolCache.
 *
 *  - First request for a key picks an account (healthy preferred) and pins it in
 *    the cache. Subsequent requests reuse the pin and DO NOT migrate (would break
 *    nonce ordering). In group mode the cache is shared, so every pod agrees.
 *  - Each ordered request acquires a ref; each terminal tx releases one. At zero
 *    refs the binding is evicted, so the sticky set is bounded by *active* keys.
 */
export class DefaultRouter implements Router {
  constructor(
    private readonly selector: WalletSelector,
    private readonly cache: PoolCache,
    private readonly ownerId: string,
  ) {}

  async route(candidates: WalletState[], req: TxRequest, opts: SubmitOptions): Promise<Address> {
    const healthy = candidates.filter((c) => c.healthy);
    const pool = healthy.length > 0 ? healthy : candidates;

    if (!opts.orderingKey) {
      return this.selector.pick(pool, req);
    }
    // Pin to the preferred account on first touch; reuse the existing pin otherwise.
    const prefer = this.selector.pick(pool, req);
    return this.cache.bindOrdering(this.ownerId, opts.orderingKey, prefer);
  }

  async bind(orderingKey: string, account: Address): Promise<void> {
    await this.cache.bindOrdering(this.ownerId, orderingKey, account);
  }

  async release(orderingKey: string): Promise<void> {
    await this.cache.releaseOrdering(this.ownerId, orderingKey);
  }

  size(): Promise<number> {
    return this.cache.orderingCount(this.ownerId);
  }
}
