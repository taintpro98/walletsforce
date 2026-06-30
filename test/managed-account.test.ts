import { describe, it, expect } from "vitest";
import { ManagedAccount, type ManagedAccountDeps } from "../src/account/managed-account";
import { LegacyFeeOracle } from "../src/fee";
import { FakeChainClient, FakeSigner, ADDR_A, hash } from "./helpers";
import type { TxEventRecord, TxStatus } from "../src/types";

function setup(over: Partial<ManagedAccountDeps> = {}) {
  const client = new FakeChainClient();
  const signer = new FakeSigner(ADDR_A);
  const events: TxEventRecord[] = [];
  const acct = new ManagedAccount({
    signer,
    chainClient: client,
    feeOracle: new LegacyFeeOracle({ minGasPriceWei: 1_000n }),
    chainId: 1,
    confirmations: 1,
    stuckAfterMs: 30_000,
    maxAttempts: 3,
    maxInflight: 2,
    emit: (r) => events.push(r),
    ...over,
  });
  return { acct, client, signer, events };
}

const statuses = (events: TxEventRecord[]): TxStatus[] => events.map((e) => e.status);

describe("ManagedAccount.submit", () => {
  it("signs, broadcasts and tracks the tx (no broadcast event — pool emits that)", async () => {
    const { acct, signer } = setup();
    const res = await acct.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    expect(res.account).toBe(ADDR_A);
    expect(res.nonce).toBe(0);
    expect(signer.signed).toHaveLength(1);
    expect(acct.state().inflightCount).toBe(1);
  });

  it("enforces the in-flight cap with backpressure", async () => {
    const { acct } = setup({ maxInflight: 1 });
    await acct.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    await expect(acct.submit({ to: ADDR_A }, { idempotencyKey: "k2" })).rejects.toThrow(/in-flight cap/);
  });

  it("frees the slot when broadcast fails", async () => {
    const { acct, client } = setup({ maxInflight: 1 });
    client.sendImpl = async () => {
      throw new Error("network down");
    };
    await expect(acct.submit({ to: ADDR_A }, { idempotencyKey: "k1" })).rejects.toThrow();
    // slot was freed -> a retry is allowed (and now succeeds)
    client.sendImpl = null;
    await expect(acct.submit({ to: ADDR_A }, { idempotencyKey: "k2" })).resolves.toBeTruthy();
  });
});

describe("ManagedAccount.confirmTick", () => {
  it("emits 'confirmed' and frees the slot once confirmations are met", async () => {
    const { acct, client, events } = setup({ confirmations: 1 });
    await acct.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    client.receipt = { status: "success", blockNumber: 100n, transactionHash: hash("1") };
    client.blockNumber = 100n; // 100 - 100 + 1 = 1 >= 1
    await acct.confirmTick();
    expect(statuses(events)).toContain("confirmed");
    expect(acct.state().inflightCount).toBe(0);
  });

  it("emits 'mined' (once) but not 'confirmed' below the confirmation depth", async () => {
    const { acct, client, events } = setup({ confirmations: 3 });
    await acct.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    client.receipt = { status: "success", blockNumber: 100n, transactionHash: hash("1") };
    client.blockNumber = 100n; // depth 1 < 3
    await acct.confirmTick();
    await acct.confirmTick(); // second pass must not re-emit mined
    expect(statuses(events).filter((s) => s === "mined")).toHaveLength(1);
    expect(statuses(events)).not.toContain("confirmed");
    expect(acct.state().inflightCount).toBe(1);
  });

  it("emits 'reverted' and frees the slot on a reverted receipt", async () => {
    const { acct, client, events } = setup();
    await acct.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    client.receipt = { status: "reverted", blockNumber: 100n, transactionHash: hash("1") };
    await acct.confirmTick();
    expect(statuses(events)).toContain("reverted");
    expect(acct.state().inflightCount).toBe(0);
  });

  it("bumps fees and replaces a stuck tx", async () => {
    const { acct, client, events, signer } = setup({ stuckAfterMs: 0, maxAttempts: 3 });
    await acct.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    client.receipt = null; // never mined
    await acct.confirmTick();
    const replaced = events.find((e) => e.status === "replaced");
    expect(replaced).toBeDefined();
    // legacy gasPrice bumped above the 1000 floor by +12.5%
    expect(replaced!.fees).toEqual({ type: "legacy", gasPrice: 1125n });
    expect(signer.signed).toHaveLength(2); // original + replacement
    expect(replaced!.attempts).toBe(2);
  });

  it("gives up ('failed') after maxAttempts and frees the slot", async () => {
    const { acct, client, events } = setup({ stuckAfterMs: 0, maxAttempts: 1 });
    await acct.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    client.receipt = null;
    await acct.confirmTick(); // attempts(1) >= maxAttempts(1) -> failed
    expect(statuses(events)).toContain("failed");
    expect(acct.state().inflightCount).toBe(0);
  });

  it("treats a nonce-drift on replacement as 'already landed' (keeps old hash, no replaced event)", async () => {
    const { acct, client, events } = setup({ stuckAfterMs: 0, maxAttempts: 5 });
    await acct.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    client.receipt = null;
    client.sendImpl = async () => {
      throw new Error("nonce too low");
    };
    await acct.confirmTick();
    expect(statuses(events)).not.toContain("replaced");
    expect(acct.state().inflightCount).toBe(1); // entry kept; next tick will confirm it
  });
});

describe("ManagedAccount.reattach / primeNonce", () => {
  it("reattach resumes tracking and seeds the lane forward", async () => {
    const { acct } = setup();
    acct.reattach({
      idempotencyKey: "k1",
      account: ADDR_A,
      nonce: 41,
      hash: hash("1"),
      fees: { type: "legacy", gasPrice: 1n },
    });
    expect(acct.state().inflightCount).toBe(1);
    expect(acct.state().nonceCursor).toBe(42);
  });

  it("never replaces a reattached (placeholder) tx — keeps polling instead of broadcasting garbage", async () => {
    const { acct, client, events, signer } = setup({ stuckAfterMs: 0, maxAttempts: 3 });
    acct.reattach({
      idempotencyKey: "r1",
      account: ADDR_A,
      nonce: 5,
      hash: hash("9"),
      fees: { type: "legacy", gasPrice: 1n },
    });
    client.receipt = null; // not mined yet -> "stuck" since stuckAfterMs=0

    await acct.confirmTick();
    // must NOT have signed/broadcast a replacement (the placeholder has no calldata)
    expect(signer.signed).toHaveLength(0);
    expect(events.find((e) => e.status === "replaced")).toBeUndefined();
    expect(events.find((e) => e.status === "failed")).toBeUndefined();
    expect(acct.state().inflightCount).toBe(1); // still tracked, not spinning to failure

    // and it confirms normally once the original tx lands
    client.receipt = { status: "success", blockNumber: 100n, transactionHash: hash("9") };
    client.blockNumber = 100n;
    await acct.confirmTick();
    expect(statuses(events)).toContain("confirmed");
    expect(acct.state().inflightCount).toBe(0);
  });

  it("primeNonce seeds the cursor from the chain's pending count", async () => {
    const { acct, client } = setup();
    client.txCount = 9;
    await acct.primeNonce();
    expect(acct.state().nonceCursor).toBe(9);
  });
});
