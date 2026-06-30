// Seam 2 — gas pricing + the replacement-bump policy. Owns per-gas PRICE only;
// the gas LIMIT is the engine's job (ChainClient.estimateGas or a TxRequest override).

import type { FeeFields } from "../types";
import type { ChainClient } from "../chain";

export interface FeeContext {
  chainId: number;
  /** 0 on first send; increments per replacement. */
  attempt: number;
  client: ChainClient;
}

export interface FeeOracle {
  estimate(ctx: FeeContext): Promise<FeeFields>;
  /** Replacement fees. MUST beat the node's rule (>= ~12.5% over `previous`). */
  bump(previous: FeeFields, ctx: FeeContext): Promise<FeeFields>;
}

/** Default replacement bump: +12.5% (geth's 10% min, with margin). */
export const DEFAULT_BUMP_NUM = 1125n;
export const DEFAULT_BUMP_DEN = 1000n;

export * from "./legacy";
export * from "./eip1559";
