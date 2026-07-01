// The lifecycle event port. A decoupled Pool and Supervisor share ONE EventBus so a
// waiter registered on the submit side resolves when the supervisor confirms. Default
// impl is in-memory (single process); a Redis-backed impl of the same interface would
// deliver events across pods (group mode).

import type { TxEvent, TxEventRecord } from "../types";

export interface WaitOptions {
  /** Reject (and clean up) if no terminal event arrives within this many ms.
   *  Without it, a waiter for a key that never settles waits forever and leaks. */
  timeoutMs?: number;
}

export interface EventBus {
  on(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  off(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  /** Resolve when this idempotencyKey reaches a terminal state (resolve on
   *  `confirmed`; reject on `reverted`/`failed`). Register right after submit —
   *  it observes FUTURE events, never one that already fired. Pass `timeoutMs` to
   *  bound the wait (recommended: a key that never settles otherwise hangs forever). */
  waitForConfirmation(idempotencyKey: string, opts?: WaitOptions): Promise<TxEventRecord>;
  /** Lifecycle sink for ManagedAccounts and the pool's submit path. */
  handle(rec: TxEventRecord): void;
}
