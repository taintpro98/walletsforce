import { describe, it, expect } from "vitest";
import { NonceLane } from "../src/account/nonce-lane";
import { FakeChainClient, ADDR_A } from "./helpers";

describe("NonceLane", () => {
  it("seeds the first nonce from the chain (pending count)", async () => {
    const client = new FakeChainClient();
    client.txCount = 7;
    const lane = new NonceLane(ADDR_A, client);
    const n = await lane.withNextNonce(async (nonce) => nonce);
    expect(n).toBe(7);
  });

  it("advances the cursor only on success and hands out gap-free nonces", async () => {
    const client = new FakeChainClient();
    client.txCount = 0;
    const lane = new NonceLane(ADDR_A, client);
    const a = await lane.withNextNonce(async (n) => n);
    const b = await lane.withNextNonce(async (n) => n);
    const c = await lane.withNextNonce(async (n) => n);
    expect([a, b, c]).toEqual([0, 1, 2]);
    expect(lane.nextNonce).toBe(3);
  });

  it("serializes concurrent callers so no nonce is reused", async () => {
    const client = new FakeChainClient();
    const lane = new NonceLane(ADDR_A, client);
    const seen = await Promise.all(
      Array.from({ length: 5 }, () =>
        lane.withNextNonce(async (n) => {
          await new Promise((r) => setTimeout(r, 1));
          return n;
        }),
      ),
    );
    expect([...seen].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(seen).size).toBe(5);
  });

  it("reuses the nonce on a non-nonce-drift failure (no gap)", async () => {
    const client = new FakeChainClient();
    const lane = new NonceLane(ADDR_A, client);
    await expect(
      lane.withNextNonce(async () => {
        throw new Error("execution reverted");
      }),
    ).rejects.toThrow();
    // cursor did not advance; next caller gets the same nonce 0
    const next = await lane.withNextNonce(async (n) => n);
    expect(next).toBe(0);
  });

  it("reseeds forward from chain truth on a nonce-drift failure", async () => {
    const client = new FakeChainClient();
    client.txCount = 0;
    const lane = new NonceLane(ADDR_A, client);
    // land nonce 0 successfully -> cursor advances to 1
    await lane.withNextNonce(async (n) => n);
    // chain jumped ahead (e.g. external sends); next attempt drifts on nonce 1
    client.txCount = 5;
    await expect(
      lane.withNextNonce(async () => {
        throw new Error("nonce too low");
      }),
    ).rejects.toThrow();
    // reseed = max(chainNonce 5, nonce+1 = 2) = 5
    const next = await lane.withNextNonce(async (n) => n);
    expect(next).toBe(5);
  });

  it("reseed() never moves the cursor backwards", () => {
    const lane = new NonceLane(ADDR_A, new FakeChainClient());
    lane.reseed(10);
    expect(lane.nextNonce).toBe(10);
    lane.reseed(4);
    expect(lane.nextNonce).toBe(10);
    lane.reseed(12);
    expect(lane.nextNonce).toBe(12);
  });
});
