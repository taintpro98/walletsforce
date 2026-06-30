// OPTIONAL observability. Exposes per-account gauges (inflight depth, nonce gap,
// balance, health) plus pool-level sizes — crucially `stickyKeys`, which is the
// leak detector for the router's sticky map. A real leak shows as a monotonically
// climbing gauge long before OOM.

import type { WalletState } from "../types";

export interface PoolSizes {
  /** Active sticky bindings in the router. */
  stickyKeys: number;
  /** Total in-flight txs across all accounts (sum of WalletState.inflightCount). */
  inflightTotal: number;
}

export interface Telemetry {
  /** Mount metrics on a host registry (e.g. a prom-client Registry). */
  register(registry: unknown): void;
  /** Refresh gauges from the latest snapshot. Call on a timer from the pool. */
  observe(input: { wallets: WalletState[]; sizes: PoolSizes }): void;
}
