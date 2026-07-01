import { describe, it, expect } from "vitest";
import { InMemoryStore } from "../src/store";
import type { AccountRecord, TransactionRecord } from "../src/store";
import type { Address, TxStatus, Hash } from "../src/types";

const A = ("0x" + "a".repeat(40)) as Address;
const B = ("0x" + "b".repeat(40)) as Address;

function txRec(key: string, account: Address, status: TxStatus, chainId = 1): TransactionRecord {
  return {
    idempotencyKey: key,
    ownerId: "owner-1",
    chainId,
    account,
    nonce: 0,
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

function acctRec(address: Address, chainId = 1): AccountRecord {
  return { ownerId: "owner-1", chainId, address, nonceCursor: 3, balanceWei: 10n, healthy: true, updatedAt: 0 };
}

describe("InMemoryStore — accounts", () => {
  it("upserts and loads accounts by owner+chain", async () => {
    const s = new InMemoryStore();
    await s.upsertAccount(acctRec(A));
    await s.upsertAccount(acctRec(B, 2)); // different chain
    const onChain1 = await s.loadAccounts("owner-1", 1);
    expect(onChain1.map((a) => a.address)).toEqual([A]);
  });

  it("last write wins per (chain, address)", async () => {
    const s = new InMemoryStore();
    await s.upsertAccount({ ...acctRec(A), nonceCursor: 3 });
    await s.upsertAccount({ ...acctRec(A), nonceCursor: 9 });
    const [a] = await s.loadAccounts("owner-1", 1);
    expect(a.nonceCursor).toBe(9);
  });
});

describe("InMemoryStore — transactions", () => {
  it("loadActiveTransactions returns only non-terminal rows for owner+chain", async () => {
    const s = new InMemoryStore();
    await s.upsertTransaction(txRec("k1", A, "broadcast"));
    await s.upsertTransaction(txRec("k2", A, "mined"));
    await s.upsertTransaction(txRec("k3", A, "replaced")); // non-terminal -> kept
    await s.upsertTransaction(txRec("k4", B, "broadcast", 2)); // other chain -> excluded
    const active = await s.loadActiveTransactions("owner-1", 1);
    expect(active.map((t) => t.idempotencyKey).sort()).toEqual(["k1", "k2", "k3"]);
  });

  it("a terminal status drops the tx (bounded memory)", async () => {
    const s = new InMemoryStore();
    await s.upsertTransaction(txRec("k1", A, "broadcast"));
    await s.upsertTransaction(txRec("k1", A, "confirmed")); // terminal -> removed
    const active = await s.loadActiveTransactions("owner-1", 1);
    expect(active).toHaveLength(0);
  });

  it("scopes by ownerId", async () => {
    const s = new InMemoryStore();
    await s.upsertTransaction({ ...txRec("k1", A, "broadcast"), ownerId: "owner-2" });
    expect(await s.loadActiveTransactions("owner-1", 1)).toHaveLength(0);
    expect(await s.loadActiveTransactions("owner-2", 1)).toHaveLength(1);
  });
});
