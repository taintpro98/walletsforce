import type { Address, TxRequest, SubmitOptions, WalletState } from "../types";
import type { Router, WalletSelector } from "./index";

/** Sticky-by-orderingKey router with ref-counted eviction.
 *
 *  - First request for a key picks an account (healthy candidates preferred) and
 *    pins it. Subsequent requests reuse the pin and DO NOT migrate — migrating a
 *    key with in-flight work to another account would break nonce ordering.
 *  - Each ordered request acquires a ref; each terminal tx releases one. At zero
 *    refs the binding is evicted, so the sticky map is bounded by *active* keys,
 *    not by all keys ever seen.
 */
export class DefaultRouter implements Router {
  private readonly sticky = new Map<string, Address>();
  private readonly active = new Map<string, number>();

  constructor(private readonly selector: WalletSelector) {}

  route(candidates: WalletState[], req: TxRequest, opts: SubmitOptions): Address {
    const healthy = candidates.filter((c) => c.healthy);
    const pool = healthy.length > 0 ? healthy : candidates;

    if (!opts.orderingKey) {
      return this.selector.pick(pool, req);
    }

    const key = opts.orderingKey;
    let addr = this.sticky.get(key);
    if (!addr) {
      addr = this.selector.pick(pool, req);
      this.sticky.set(key, addr);
    }
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    return addr;
  }

  bind(orderingKey: string, account: Address): void {
    if (!this.sticky.has(orderingKey)) this.sticky.set(orderingKey, account);
    this.active.set(orderingKey, (this.active.get(orderingKey) ?? 0) + 1);
  }

  release(orderingKey: string): void {
    const next = (this.active.get(orderingKey) ?? 0) - 1;
    if (next <= 0) {
      this.active.delete(orderingKey);
      this.sticky.delete(orderingKey); // evict — no active work left
    } else {
      this.active.set(orderingKey, next);
    }
  }

  size(): number {
    return this.sticky.size;
  }
}
