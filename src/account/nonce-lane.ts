// Per-account nonce lane: an async mutex + nonce allocator. Serializes everything
// touching this account's nonce so two txs can never grab the same number; the
// cursor advances only on success (a failed send reuses the nonce — no gap).
// Mirrors apps/executor NonceManager / apps/dvn withNextNonce.

import type { Address } from "../types";
import type { ChainClient } from "../chain";

export class NonceLane {
  private cursor: number | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly address: Address,
    private readonly client: ChainClient,
  ) {}

  /** Run `fn(nonce)` under this lane's mutex. The mutex covers allocation +
   *  broadcast only (the caller does receipt-waiting outside), so the lane
   *  pipelines: nonce N+1 starts as soon as N is on the wire. */
  async withNextNonce<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const nonce =
        this.cursor ?? (await this.client.getTransactionCount(this.address, "pending"));
      try {
        const result = await fn(nonce);
        this.cursor = nonce + 1; // advance only on success
        return result;
      } catch (err) {
        if (this.client.classifyError(err) === "nonce-drift") {
          const chainNonce = await this.client
            .getTransactionCount(this.address, "pending")
            .catch(() => 0);
          this.cursor = Math.max(chainNonce, nonce + 1);
        }
        throw err;
      }
    });
    // Keep the lane alive whether the turn resolved or threw.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Re-seed the cursor forward (boot reconciliation / reattach). Never moves it back. */
  reseed(atLeast: number): void {
    this.cursor = this.cursor === undefined ? atLeast : Math.max(this.cursor, atLeast);
  }

  get nextNonce(): number | undefined {
    return this.cursor;
  }
}
