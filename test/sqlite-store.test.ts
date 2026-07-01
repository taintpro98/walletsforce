import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { SqliteStore, InMemoryStore, createStore } from "../src/store";
import type { AccountRecord, TransactionRecord } from "../src/store";
import { ADDR_A, ADDR_B, hash } from "./helpers";

const files: string[] = [];
const tmpDb = () => {
  const p = join(tmpdir(), `wf-${randomUUID()}.sqlite`);
  files.push(p);
  return p;
};
afterEach(() => {
  for (const f of files.splice(0)) rmSync(f, { force: true });
});

const account = (over: Partial<AccountRecord> = {}): AccountRecord => ({
  ownerId: "o", chainId: 1, address: ADDR_A, nonceCursor: 3,
  balanceWei: 12_345_678_901_234_567_890n, healthy: true, updatedAt: 100, ...over,
});
const tx = (over: Partial<TransactionRecord> = {}): TransactionRecord => ({
  idempotencyKey: "k1", ownerId: "o", chainId: 1, account: ADDR_A, nonce: 7,
  to: ADDR_B, data: "0xabcdef", value: 10n ** 18n, gas: 21_000n,
  fees: { type: "legacy", gasPrice: 1_000_000_000n },
  hash: hash("1"), status: "broadcast", attempts: 1, submittedAt: 50,
  minedEmitted: false, orderingKey: "p", metadata: { tag: "x", n: 2 },
  replaceable: true, updatedAt: 60, ...over,
});

describe("createStore factory", () => {
  it("returns InMemoryStore for memory and SqliteStore for sqlite", () => {
    expect(createStore({ kind: "memory" })).toBeInstanceOf(InMemoryStore);
    const s = createStore({ kind: "sqlite", path: ":memory:" });
    expect(s).toBeInstanceOf(SqliteStore);
  });
});

describe("SqliteStore", () => {
  it("round-trips an account (bigint balance, derivationIndex, healthy)", async () => {
    const s = new SqliteStore(":memory:");
    await s.upsertAccount(account({ derivationIndex: 4, healthy: false }));
    const [rec] = await s.loadAccounts("o", 1);
    expect(rec).toMatchObject({
      ownerId: "o", chainId: 1, nonceCursor: 3,
      balanceWei: 12_345_678_901_234_567_890n, derivationIndex: 4, healthy: false,
    });
    expect(rec.address.toLowerCase()).toBe(ADDR_A.toLowerCase());
  });

  it("upsert overwrites the same (chain_id, address)", async () => {
    const s = new SqliteStore(":memory:");
    await s.upsertAccount(account({ nonceCursor: 1 }));
    await s.upsertAccount(account({ nonceCursor: 9, healthy: false }));
    const rows = await s.loadAccounts("o", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].nonceCursor).toBe(9);
  });

  it("round-trips a legacy tx with all optional fields", async () => {
    const s = new SqliteStore(":memory:");
    await s.upsertTransaction(tx());
    const [r] = await s.loadActiveTransactions("o", 1);
    expect(r).toEqual(tx());
  });

  it("round-trips an eip1559 tx and omitted optionals", async () => {
    const s = new SqliteStore(":memory:");
    const t = tx({
      idempotencyKey: "k2",
      fees: { type: "eip1559", maxFeePerGas: 5n, maxPriorityFeePerGas: 2n },
      data: undefined, value: undefined, orderingKey: undefined, metadata: undefined,
      replaceable: undefined,
    });
    await s.upsertTransaction(t);
    const [r] = await s.loadActiveTransactions("o", 1);
    expect(r).toEqual(t);
  });

  it("retains terminal rows but excludes them from loadActiveTransactions", async () => {
    const s = new SqliteStore(":memory:");
    await s.upsertTransaction(tx({ idempotencyKey: "a", status: "broadcast" }));
    await s.upsertTransaction(tx({ idempotencyKey: "b", status: "confirmed" }));
    const active = await s.loadActiveTransactions("o", 1);
    expect(active.map((t) => t.idempotencyKey)).toEqual(["a"]);
  });

  it("survives a reopen — crash recovery from the same file", async () => {
    const path = tmpDb();
    const s1 = new SqliteStore(path);
    await s1.upsertAccount(account());
    await s1.upsertTransaction(tx({ idempotencyKey: "live", status: "broadcast" }));
    await s1.upsertTransaction(tx({ idempotencyKey: "done", status: "confirmed" }));
    s1.close();

    // "restart": a fresh store over the same file sees the durable state
    const s2 = new SqliteStore(path);
    expect(await s2.loadAccounts("o", 1)).toHaveLength(1);
    const active = await s2.loadActiveTransactions("o", 1);
    expect(active.map((t) => t.idempotencyKey)).toEqual(["live"]); // terminal 'done' retained but not active
    s2.close();
  });

  it("scopes loads by ownerId + chainId", async () => {
    const s = new SqliteStore(":memory:");
    await s.upsertTransaction(tx({ idempotencyKey: "k1", ownerId: "o", chainId: 1 }));
    await s.upsertTransaction(tx({ idempotencyKey: "k2", ownerId: "other", chainId: 1 }));
    await s.upsertTransaction(tx({ idempotencyKey: "k3", ownerId: "o", chainId: 2 }));
    const rows = await s.loadActiveTransactions("o", 1);
    expect(rows.map((t) => t.idempotencyKey)).toEqual(["k1"]);
  });
});
