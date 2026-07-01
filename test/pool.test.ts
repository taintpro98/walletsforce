import { describe, it, expect, afterEach } from "vitest";
import { WalletForcePool } from "../src/pool";
import { Supervisor } from "../src/supervisor";
import { LegacyFeeOracle } from "../src/fee";
import { InMemoryStore } from "../src/store";
import { InMemoryCache } from "../src/cache";
import { createSubstrate, type SubstrateOptions } from "../src/substrate";
import { FakeChainClient, FakeSigner, ADDR_A, ADDR_B, hash } from "./helpers";
import type { WalletPoolConfig, SupervisorConfig } from "../src/config";
import type { TxEventRecord } from "../src/types";

// A combined config carrying both pool- and supervisor-side fields, so one object can
// seed both in these single-pod tests (the constructors each read their own subset).
type TestConfig = WalletPoolConfig & SupervisorConfig;

// Build a pool over a substrate (cache + store + bus + the shared account set). `shared`
// lets a test reuse external cache/store across substrates (a shared store for a
// crash→restore test, or a shared cache+store for the cross-pod test). Returns the
// substrate so a separately-built `new Supervisor(config, substrate)` ticks the SAME
// account set (single-pod) or its own set over the shared backends (cross-pod).
function makePool(
  over: Partial<TestConfig> = {},
  client = new FakeChainClient(),
  shared: SubstrateOptions = {},
) {
  const config: TestConfig = {
    ownerId: "test",
    chainId: 1,
    signers: [new FakeSigner(ADDR_A), new FakeSigner(ADDR_B)],
    chainClient: client,
    feeOracle: new LegacyFeeOracle({ minGasPriceWei: 1_000n }),
    confirmations: 1,
    confirmTickMs: 5,
    ...over,
  };
  const substrate = createSubstrate(config, shared);
  const pool = new WalletForcePool(config, substrate);
  return { pool, config, substrate, client };
}

// the supervisor(s) started during a test — stopped in teardown
let active: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.allSettled(active.map((s) => s.stop()));
  active = [];
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
    expect((await pool.stats()).stickyKeys).toBe(1);
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
    const { pool, config, substrate } = makePool({}, client);
    await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1", orderingKey: "p" });
    expect((await pool.stats()).stickyKeys).toBe(1);
    const waiter = pool.waitForConfirmation("k1");
    client.receipt = { status: "success", blockNumber: 100n, transactionHash: hash("1") };
    client.blockNumber = 100n;
    const sup = new Supervisor(config, substrate);
    active.push(sup);
    sup.start();
    const rec = await waiter;
    expect(rec.status).toBe("confirmed");
    expect((await pool.stats()).stickyKeys).toBe(0); // released on terminal
  });

  it("does not leak a sticky ref when an ordered submit fails (backpressure)", async () => {
    const client = new FakeChainClient();
    const { pool, config, substrate } = makePool({ signers: [new FakeSigner(ADDR_A)], maxInflightPerAccount: 1 }, client);
    const waiter = pool.waitForConfirmation("k1");
    await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1", orderingKey: "ord" });
    expect((await pool.stats()).stickyKeys).toBe(1);
    // second submit for the same ordering key hits the in-flight cap and throws
    await expect(
      pool.submit({ to: ADDR_A }, { idempotencyKey: "k2", orderingKey: "ord" }),
    ).rejects.toThrow(/in-flight cap/);
    // confirm k1 -> its ref releases. If the failed submit had leaked a ref, the
    // binding would survive with a non-zero count. It must be fully evicted.
    client.receipt = { status: "success", blockNumber: 100n, transactionHash: hash("1") };
    client.blockNumber = 100n;
    const sup = new Supervisor(config, substrate);
    active.push(sup);
    sup.start();
    await waiter;
    expect((await pool.stats()).stickyKeys).toBe(0);
  });

  it("rejects on reverted", async () => {
    const client = new FakeChainClient();
    const { pool, config, substrate } = makePool({}, client);
    await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    const waiter = pool.waitForConfirmation("k1");
    client.receipt = { status: "reverted", blockNumber: 100n, transactionHash: hash("1") };
    const sup = new Supervisor(config, substrate);
    active.push(sup);
    sup.start();
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
    const { config, substrate } = makePool(
      { signers: [new FakeSigner(ADDR_A)], minBalanceWei: 1_000n },
      client,
    );
    const sup = new Supervisor(config, substrate, funder);
    sup.start();
    await new Promise((r) => setTimeout(r, 30)); // let the first tick run refreshBalances
    await sup.stop();
    expect(topped).toContain(ADDR_A.toLowerCase());
  });

  it("wallets() reports one state per signer (from the store)", async () => {
    const { pool } = makePool();
    await pool.restore(); // seeds the accounts into the store
    const w = await pool.wallets();
    expect(w).toHaveLength(2);
    expect(w.map((x) => x.address.toLowerCase()).sort()).toEqual(
      [ADDR_A, ADDR_B].map((x) => x.toLowerCase()).sort(),
    );
  });

  it("reattach resumes tracking and binds an ordering key", async () => {
    const { pool } = makePool();
    await pool.reattach({
      idempotencyKey: "k1",
      account: ADDR_A,
      nonce: 5,
      hash: hash("1"),
      fees: { type: "legacy", gasPrice: 1n },
      orderingKey: "p",
    });
    const state = (await pool.wallets()).find((w) => w.address.toLowerCase() === ADDR_A.toLowerCase());
    expect(state?.inflightCount).toBe(1);
    expect((await pool.stats()).stickyKeys).toBe(1);
  });

  it("restore() rebuilds in-flight state from a shared store (crash → resume)", async () => {
    const store = new InMemoryStore();
    // pool 1: submit two ordered txs (broadcast, write-through to the store), then "crash"
    const { pool: p1 } = makePool({ signers: [new FakeSigner(ADDR_A)], maxInflightPerAccount: 10 }, undefined, { store });
    await p1.submit({ to: ADDR_A }, { idempotencyKey: "k1", orderingKey: "p" });
    await p1.submit({ to: ADDR_A }, { idempotencyKey: "k2", orderingKey: "p" });
    expect((await p1.wallets())[0].inflightCount).toBe(2); // p1 never ran a supervisor

    // pool 2: fresh instance, same store (fresh cache) -> restore() re-tracks both + the sticky binding
    const { pool: p2 } = makePool({ signers: [new FakeSigner(ADDR_A)], maxInflightPerAccount: 10 }, undefined, { store });
    const restored = await p2.restore();
    expect(restored).toBe(2);
    expect((await p2.wallets())[0].inflightCount).toBe(2);
    expect((await p2.wallets())[0].nonceCursor).toBe(2); // lane reseeded past the restored nonces
    expect((await p2.stats()).stickyKeys).toBe(1); // sticky binding rebuilt
  });

  it("restore() rebroadcasts write-ahead (pending) txs that may not have been sent", async () => {
    const store = new InMemoryStore();
    // Simulate a crash right after the write-ahead row was committed but before/at
    // broadcast: a "pending" tx sits in the store, not yet on-chain.
    await store.upsertTransaction({
      idempotencyKey: "k1",
      ownerId: "test",
      chainId: 1,
      account: ADDR_A,
      nonce: 0,
      to: ADDR_A,
      gas: 21_000n,
      fees: { type: "legacy", gasPrice: 1n },
      hash: ("0x" + "0".repeat(64)) as `0x${string}`,
      status: "pending",
      attempts: 1,
      submittedAt: 0,
      minedEmitted: false,
      replaceable: true,
      updatedAt: 0,
    });

    const client = new FakeChainClient();
    const { pool } = makePool({ signers: [new FakeSigner(ADDR_A)] }, client, { store });
    const restored = await pool.restore();
    expect(restored).toBe(1);
    expect(client.sent).toHaveLength(1); // the pending tx was (re)broadcast
    expect((await pool.wallets())[0].inflightCount).toBe(1); // now tracked
  });

  it("a pool with no supervisor started never confirms (the caller owns the loop)", async () => {
    const client = new FakeChainClient();
    const { pool } = makePool({ signers: [new FakeSigner(ADDR_A)] }, client);
    await pool.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    client.receipt = { status: "success", blockNumber: 100n, transactionHash: hash("1") };
    client.blockNumber = 100n;
    // no Supervisor constructed/started -> no tick -> nothing confirms
    await new Promise((r) => setTimeout(r, 30));
    expect((await pool.wallets())[0].inflightCount).toBe(1);
  });

  it("a separate supervisor confirms a submitter's txs over the shared cache+store", async () => {
    const cache = new InMemoryCache();
    const store = new InMemoryStore();
    const client = new FakeChainClient();
    // submitter pod: submits (write-through to the SHARED cache+store), no supervisor started.
    // Its OWN bus (separate process) — cross-pod state is shared via cache+store, not the bus.
    const { pool: submitter } = makePool({ signers: [new FakeSigner(ADDR_A)] }, client, { cache, store });
    await submitter.submit({ to: ADDR_A }, { idempotencyKey: "k1" });
    expect((await submitter.wallets())[0].inflightCount).toBe(1);

    // supervisor pod: same cache+store+signer, its OWN bus (separate process); the
    // caller constructs a Supervisor from params — no pool needed on this instance.
    const { config: supConfig, substrate: supSubstrate } = makePool(
      { signers: [new FakeSigner(ADDR_A)], confirmTickMs: 5 },
      client,
      { cache, store },
    );
    const sup = new Supervisor(supConfig, supSubstrate);
    active.push(sup);
    client.receipt = { status: "success", blockNumber: 100n, transactionHash: hash("1") };
    client.blockNumber = 100n;
    sup.start();
    for (let i = 0; i < 20 && (await submitter.wallets())[0].inflightCount > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await submitter.wallets())[0].inflightCount).toBe(0); // supervisor settled it via the shared cache
  });

  it("reattach throws for an unknown account", async () => {
    const { pool } = makePool();
    await expect(
      pool.reattach({
        idempotencyKey: "k1",
        account: ("0x" + "9".repeat(40)) as never,
        nonce: 0,
        hash: hash("1"),
        fees: { type: "legacy", gasPrice: 1n },
      }),
    ).rejects.toThrow(/no account/);
  });
});
