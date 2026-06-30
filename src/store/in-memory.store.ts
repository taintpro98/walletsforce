// In-memory PoolStore. For dev/tests only — a crash loses tracking. A durable
// adapter (e.g. SQLite) is a TODO; production consumers map on()/reattach() onto
// their own store instead.

import type { Address, TxEventRecord, TxStatus } from "../types";
import type { PoolStore } from "./index";

const TERMINAL: ReadonlySet<TxStatus> = new Set<TxStatus>(["confirmed", "reverted", "failed"]);

export class InMemoryStore implements PoolStore {
  private readonly byKey = new Map<string, TxEventRecord>();

  async record(rec: TxEventRecord): Promise<void> {
    this.byKey.set(rec.idempotencyKey, rec);
  }

  async loadActive(wallets: Address[]): Promise<TxEventRecord[]> {
    const owned = new Set(wallets.map((w) => w.toLowerCase()));
    return [...this.byKey.values()].filter(
      (r) => !TERMINAL.has(r.status) && owned.has(r.account.toLowerCase()),
    );
  }
}
