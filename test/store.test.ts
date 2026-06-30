import { describe, it, expect } from "vitest";
import { InMemoryStore } from "../src/store";
import type { TxEventRecord, TxStatus, Address } from "../src/types";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);

function rec(key: string, account: string, status: TxStatus): TxEventRecord {
  return {
    idempotencyKey: key,
    account: account as Address,
    nonce: 0,
    hash: ("0x" + "1".repeat(64)) as TxEventRecord["hash"],
    status,
    fees: { type: "legacy", gasPrice: 1n },
    attempts: 1,
    at: 0,
  };
}

describe("InMemoryStore", () => {
  it("records by idempotencyKey, last write wins", async () => {
    const s = new InMemoryStore();
    await s.record(rec("k1", A, "broadcast"));
    await s.record(rec("k1", A, "confirmed"));
    const active = await s.loadActive([A as Address]);
    expect(active).toHaveLength(0); // latest state is terminal -> not active
  });

  it("loadActive returns only non-terminal records for owned wallets", async () => {
    const s = new InMemoryStore();
    await s.record(rec("k1", A, "broadcast"));
    await s.record(rec("k2", A, "mined"));
    await s.record(rec("k3", A, "confirmed")); // terminal -> excluded
    await s.record(rec("k4", A, "reverted")); // terminal -> excluded
    await s.record(rec("k5", B, "broadcast")); // not owned -> excluded
    const active = await s.loadActive([A as Address]);
    expect(active.map((r) => r.idempotencyKey).sort()).toEqual(["k1", "k2"]);
  });

  it("matches wallet ownership case-insensitively", async () => {
    const s = new InMemoryStore();
    await s.record(rec("k1", A.toUpperCase().replace("0X", "0x"), "broadcast"));
    const active = await s.loadActive([A.toLowerCase() as Address]);
    expect(active).toHaveLength(1);
  });
});
