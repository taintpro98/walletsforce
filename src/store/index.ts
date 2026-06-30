// OPTIONAL sugar — NOT a core component. walletsforce persists nothing itself;
// the caller owns durability via on()/reattach(). This adapter wires those hooks
// to a store for services that have none of their own.

import type { Address, TxEventRecord } from "../types";

export interface PoolStore {
  /** Write-through on each lifecycle event. */
  record(rec: TxEventRecord): Promise<void>;
  /** Non-terminal records for these wallets — feeds reattach() on boot. */
  loadActive(wallets: Address[]): Promise<TxEventRecord[]>;
}

export * from "./in-memory.store";
