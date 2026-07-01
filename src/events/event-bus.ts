// The lifecycle event sink, extracted from the pool so a decoupled Pool and
// Supervisor can share ONE event surface. Every ManagedAccount emits here; the
// bus fans events out to `on()` subscribers and, on a TERMINAL event, releases
// the sticky ordering ref and resolves/rejects any waitForConfirmation promise.
//
// In-memory = single process: the pool (submit → broadcast) and the supervisor
// (tick → confirmed/replaced/failed) share one bus, so a waiter registered on
// the submit side resolves when the supervisor confirms. In group mode each pod
// has its own bus (cross-pod delivery is a future RedisEventBus); the sticky
// release still works because it goes through the shared cache.

import type { TxEvent, TxEventRecord, Logger } from "../types";
import type { PoolCache } from "../cache";

const TERMINAL: ReadonlySet<TxEvent> = new Set<TxEvent>([
  "confirmed",
  "reverted",
  "failed",
]);

export interface EventBus {
  on(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  off(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  /** Resolve when this idempotencyKey reaches a terminal state (resolve on
   *  `confirmed`; reject on `reverted`/`failed`). Register right after submit —
   *  it observes FUTURE events, never one that already fired. */
  waitForConfirmation(idempotencyKey: string): Promise<TxEventRecord>;
  /** Lifecycle sink for ManagedAccounts and the pool's submit path. */
  handle(rec: TxEventRecord): void;
}

export interface InMemoryEventBusDeps {
  /** Used to release the sticky ordering ref on a terminal event. */
  cache: PoolCache;
  ownerId: string;
  logger?: Logger;
}

export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Map<TxEvent, Set<(rec: TxEventRecord) => void>>();
  /** idempotencyKey -> pending waitForConfirmation resolvers. O(1) dispatch, one
   *  small entry per active waiter (vs. registering listeners that scan per event). */
  private readonly waiters = new Map<
    string,
    Array<{ resolve: (r: TxEventRecord) => void; reject: (e: Error) => void }>
  >();

  constructor(private readonly deps: InMemoryEventBusDeps) {}

  on(event: TxEvent, cb: (rec: TxEventRecord) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
  }

  off(event: TxEvent, cb: (rec: TxEventRecord) => void): void {
    this.listeners.get(event)?.delete(cb);
  }

  waitForConfirmation(idempotencyKey: string): Promise<TxEventRecord> {
    return new Promise<TxEventRecord>((resolve, reject) => {
      const arr = this.waiters.get(idempotencyKey);
      if (arr) arr.push({ resolve, reject });
      else this.waiters.set(idempotencyKey, [{ resolve, reject }]);
    });
  }

  /** Single sink for every lifecycle event: fan out to subscribers, then on a
   *  terminal event release the sticky ref (cache op) and settle waiters. */
  handle(rec: TxEventRecord): void {
    for (const cb of this.listeners.get(rec.status) ?? []) cb(rec);
    if (!TERMINAL.has(rec.status)) return;

    // release the sticky ref — fire-and-forget; idempotent, non-critical.
    if (rec.orderingKey) {
      void this.deps.cache
        .releaseOrdering(this.deps.ownerId, rec.orderingKey)
        .catch((e) => this.deps.logger?.error("releaseOrdering failed", e));
    }

    const arr = this.waiters.get(rec.idempotencyKey);
    if (arr) {
      this.waiters.delete(rec.idempotencyKey);
      for (const w of arr) {
        if (rec.status === "confirmed") w.resolve(rec);
        else
          w.reject(
            new Error(
              `tx ${rec.status}${rec.error ? `: ${rec.error}` : ""} (idempotencyKey=${rec.idempotencyKey})`,
            ),
          );
      }
    }
  }
}
