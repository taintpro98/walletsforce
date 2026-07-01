import { describe, it, expect } from "vitest";
import { InMemoryCache } from "../src/cache";
import type { AccountRecord, TransactionRecord } from "../src/store";
import type { Address, Hash, TxStatus } from "../src/types";

const A = ("0x" + "a".repeat(40)) as Address;
const B = ("0x" + "b".repeat(40)) as Address;

function txRec(account: Address, nonce: number, status: TxStatus = "broadcast"): TransactionRecord {
  return {
    idempotencyKey: `${account}-${nonce}`,
    ownerId: "o",
    chainId: 1,
    account,
    nonce,
    to: B,
    gas: 21_000n,
    fees: { type: "legacy", gasPrice: 1n },
    hash: ("0x" + "1".repeat(64)) as Hash,
    status,
    attempts: 1,
    submittedAt: 0,
    minedEmitted: false,
    updatedAt: 0,
  };
}

const acct = (address: Address, nonceCursor = 0): AccountRecord => ({
  ownerId: "o",
  chainId: 1,
  address,
  nonceCursor,
  balanceWei: 5n,
  healthy: true,
  updatedAt: 0,
});

describe("InMemoryCache — nonce lane", () => {
  it("hands out gap-free nonces and advances only on success", async () => {
    const c = new InMemoryCache();
    const a = await c.withNonce(A, async (n) => n);
    const b = await c.withNonce(A, async (n) => n);
    expect([a, b]).toEqual([0, 1]);
    expect(await c.peekNonce(A)).toBe(2);
  });

  it("reuses the nonce when fn throws (no gap)", async () => {
    const c = new InMemoryCache();
    await expect(c.withNonce(A, async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(await c.withNonce(A, async (n) => n)).toBe(0); // same nonce reused
  });

  it("serializes concurrent callers per account", async () => {
    const c = new InMemoryCache();
    const seen = await Promise.all(
      Array.from({ length: 5 }, () =>
        c.withNonce(A, async (n) => { await new Promise((r) => setTimeout(r, 1)); return n; }),
      ),
    );
    expect([...seen].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
  });

  it("seedNonce only moves forward", async () => {
    const c = new InMemoryCache();
    await c.seedNonce(A, 10);
    expect(await c.peekNonce(A)).toBe(10);
    await c.seedNonce(A, 4);
    expect(await c.peekNonce(A)).toBe(10);
  });
});

describe("InMemoryCache — tx working set", () => {
  it("puts, lists (sorted), counts and drops", async () => {
    const c = new InMemoryCache();
    await c.putTx(txRec(A, 1));
    await c.putTx(txRec(A, 0));
    await c.putTx(txRec(B, 0));
    expect((await c.listTxs(A)).map((t) => t.nonce)).toEqual([0, 1]);
    expect(await c.countTxs(A)).toBe(2);
    await c.dropTx(A, 0);
    expect(await c.countTxs(A)).toBe(1);
  });
});

describe("InMemoryCache — accounts + ordering", () => {
  it("lists accounts by owner+chain", async () => {
    const c = new InMemoryCache();
    await c.putAccount(acct(A));
    await c.putAccount(acct(B));
    expect((await c.listAccounts("o", 1)).length).toBe(2);
    expect((await c.listAccounts("o", 2)).length).toBe(0);
  });

  it("pins an ordering key and ref-counts to eviction", async () => {
    const c = new InMemoryCache();
    expect(await c.bindOrdering("o", "k", A)).toBe(A);
    expect(await c.bindOrdering("o", "k", B)).toBe(A); // pinned to A, no migration
    expect(await c.orderingCount("o")).toBe(1);
    await c.releaseOrdering("o", "k");
    expect(await c.orderingCount("o")).toBe(1); // one ref left
    await c.releaseOrdering("o", "k");
    expect(await c.orderingCount("o")).toBe(0); // evicted
  });
});
