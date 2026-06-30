// A pool is single-chain; this is the thin multi-chain wrapper.

import type { WalletForcePool } from "./pool";

export class PoolRegistry {
  private readonly pools = new Map<number, WalletForcePool>();

  register(chainId: number, pool: WalletForcePool): void {
    this.pools.set(chainId, pool);
  }

  get(chainId: number): WalletForcePool {
    const pool = this.pools.get(chainId);
    if (!pool) throw new Error(`no walletsforce pool for chain ${chainId}`);
    return pool;
  }
}
