import { describe, it, expect, afterEach } from "vitest";
import { WalletForcePool } from "../src/pool";
import { LegacyFeeOracle } from "../src/fee";
import { FakeChainClient, FakeSigner, ADDR_A, ADDR_B, hash } from "./helpers";
import type { WalletPoolConfig } from "../src/config";
import type { TxEventRecord } from "../src/types";

function makePool(over: Partial<WalletPoolConfig> = {}, client = new FakeChainClient()) {
  const pool = new WalletForcePool({
    ownerId: "test",
    chainId: 1,
    signers: [new FakeSigner(ADDR_A), new FakeSigner(ADDR_B)],
    chainClient: client,
    feeOracle: new LegacyFeeOracle({ minGasPriceWei: 1_000n }),
    confirmations: 1,
    confirmTickMs: 5,
    ...over,
  });
  return { pool, client };
}

let active: WalletForcePool | null = null;
afterEach(async () => {
  await active?.stop();
  active = null;
});

describe("WalletForcePool.submit", () => {
  it("routes, broadcasts and emits a 'broadcast' event", async () => {
    const { pool } = makePool();
    const seen: TxEventRecord[] = [];
    pool.on("broadcast", (r) => seen.push(r));
    const res = await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    expect(res.nonce).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ idempotencyKey: "k1", status: "broadcast" });
  });

  it("validates input and rejects a bad request", async () => {
    const { pool } = makePool();
    await expect(pool.submit({ to: "nope" } as never, { idempotencyKey: "k1" })).rejects.toThrow();
    await expect(pool.submit({ to: ADDR_A }, { idempotencyKey: "" } as never)).rejects.toThrow();
  });

  it("spreads unordered load across accounts (least-inflight)", async () => {
    const { pool } = makePool();
    const a = await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    const b = await pool.submit({ to: ADDR_A }, { idempotencyKey: "k2" });
    expect(a.account.toLowerCase()).not.toBe(b.account.toLowerCase());
  });

  it("pins an ordering key to one account and reflects it in stats", async () => {
    const { pool } = makePool();
    const a = await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1", orderingKey: "p" });
    const b = await pool.submit({ to: ADDR_A }, { idempotencyKey: "k2", orderingKey: "p" });
    expect(a.account.toLowerCase()).toBe(b.account.toLowerCase());
    expect(pool.stats().stickyKeys).toBe(1);
  });

  it("applies per-account backpressure", async () => {
    const { pool } = makePool({ signers: [new FakeSigner(ADDR_A)], maxInflightPerAccount: 1 });
    await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    await expect(pool.submit({ to: ADDR_A }, { idempotencyKey: "k2" })).rejects.toThrow(/in-flight cap/);
  });
});

describe("WalletForcePool.waitForConfirmation", () => {
  it("resolves on confirmed and releases the sticky ref", async () => {
    const client = new FakeChainClient();
    const { pool } = makePool({}, client);
    active = pool;
    await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1", orderingKey: "p" });
    expect(pool.stats().stickyKeys).toBe(1);
    const waiter = pool.waitForConfirmation("k1");
    client.receipt = { status: "success", blockNumber: 100n, transactionHash: hash("1") };
    client.blockNumber = 100n;
    pool.start();
    const rec = await waiter;
    expect(rec.status).toBe("confirmed");
    expect(pool.stats().stickyKeys).toBe(0); // released on terminal
  });

  it("does not leak a sticky ref when an ordered submit fails (backpressure)", async () => {
    const client = new FakeChainClient();
    const { pool } = makePool({ signers: [new FakeSigner(ADDR_A)], maxInflightPerAccount: 1 }, client);
    active = pool;
    const waiter = pool.waitForConfirmation("k1");
    await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1", orderingKey: "ord" });
    expect(pool.stats().stickyKeys).toBe(1);
    // second submit for the same ordering key hits the in-flight cap and throws
    await expect(
      pool.submit({ to: ADDR_A }, { idempotencyKey: "k2", orderingKey: "ord" }),
    ).rejects.toThrow(/in-flight cap/);
    // confirm k1 -> its ref releases. If the failed submit had leaked a ref, the
    // binding would survive with a non-zero count. It must be fully evicted.
    client.receipt = { status: "success", blockNumber: 100n, transactionHash: hash("1") };
    client.blockNumber = 100n;
    pool.start();
    await waiter;
    expect(pool.stats().stickyKeys).toBe(0);
  });

  it("rejects on reverted", async () => {
    const client = new FakeChainClient();
    const { pool } = makePool({}, client);
    active = pool;
    await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    const waiter = pool.waitForConfirmation("k1");
    client.receipt = { status: "reverted", blockNumber: 100n, transactionHash: hash("1") };
    pool.start();
    await expect(waiter).rejects.toThrow(/reverted/);
  });
});

describe("WalletForcePool events / state", () => {
  it("off() removes a listener", async () => {
    const { pool } = makePool();
    const seen: TxEventRecord[] = [];
    const cb = (r: TxEventRecord) => seen.push(r);
    pool.on("broadcast", cb);
    pool.off("broadcast", cb);
    await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    expect(seen).toHaveLength(0);
  });

  it("calls funder.maybeTopUp for accounts below minBalanceWei", async () => {
    const client = new FakeChainClient();
    client.balance = 1n; // below the threshold
    const topped: string[] = [];
    const funder = { maybeTopUp: async (addr: string) => { topped.push(addr.toLowerCase()); } };
    const { pool } = makePool(
      { signers: [new FakeSigner(ADDR_A)], minBalanceWei: 1_000n, funder: funder as never },
      client,
    );
    active = pool;
    pool.start();
    await new Promise((r) => setTimeout(r, 30)); // let the first tick run refreshBalances
    await pool.stop();
    expect(topped).toContain(ADDR_A.toLowerCase());
  });

  it("wallets() reports one state per signer", () => {
    const { pool } = makePool();
    const w = pool.wallets();
    expect(w).toHaveLength(2);
    expect(w.map((x) => x.address.toLowerCase()).sort()).toEqual(
      [ADDR_A, ADDR_B].map((x) => x.toLowerCase()).sort(),
    );
  });

  it("reattach resumes tracking and binds an ordering key", () => {
    const { pool } = makePool();
    pool.reattach({
      idempotencyKey: "k1",
      account: ADDR_A,
      nonce: 5,
      hash: hash("1"),
      fees: { type: "legacy", gasPrice: 1n },
      orderingKey: "p",
    });
    const state = pool.wallets().find((w) => w.address.toLowerCase() === ADDR_A.toLowerCase());
    expect(state?.inflightCount).toBe(1);
    expect(pool.stats().stickyKeys).toBe(1);
  });

  it("reattach throws for an unknown account", () => {
    const { pool } = makePool();
    expect(() =>
      pool.reattach({
        idempotencyKey: "k1",
        account: ("0x" + "9".repeat(40)) as never,
        nonce: 0,
        hash: hash("1"),
        fees: { type: "legacy", gasPrice: 1n },
      }),
    ).toThrow(/no account/);
  });
});
