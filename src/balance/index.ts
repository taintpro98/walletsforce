// OPTIONAL add-ons. BalanceMonitor marks drained accounts unhealthy so the Router
// drops them from rotation; Funder optionally tops them up from a treasury account.

import type { Address } from "../types";

export interface BalanceMonitor {
  start(): void;
  stop(): void;
  /** false when balance < configured minimum. */
  isHealthy(addr: Address): boolean;
}

export interface Funder {
  /** Top up a low account from a treasury account. */
  maybeTopUp(addr: Address): Promise<void>;
}
