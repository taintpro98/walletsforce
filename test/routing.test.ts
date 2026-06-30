import { describe, it, expect } from "vitest";
import { LeastInflightSelector } from "../src/routing/least-inflight.selector";
import { DefaultRouter } from "../src/routing/default-router";
import type { WalletState, TxRequest, SubmitOptions, Address } from "../src/types";

const W = (address: string, inflightCount: number, healthy = true): WalletState => ({
  address: address as Address,
  inflightCount,
  nonceCursor: 0,
  balanceWei: 1n,
  healthy,
});

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const req: TxRequest = { to: A as Address };

describe("LeastInflightSelector", () => {
  it("picks the account with the fewest in-flight txs", () => {
    const s = new LeastInflightSelector();
    expect(s.pick([W(A, 5), W(B, 2), W(C, 9)], req)).toBe(B);
  });
  it("throws when there are no candidates", () => {
    expect(() => new LeastInflightSelector().pick([], req)).toThrow(/no candidate/);
  });
});

describe("DefaultRouter", () => {
  const opts = (orderingKey?: string): SubmitOptions => ({ idempotencyKey: "k", orderingKey });

  it("routes unordered requests via the selector (least-inflight)", () => {
    const r = new DefaultRouter(new LeastInflightSelector());
    expect(r.route([W(A, 3), W(B, 1)], req, opts())).toBe(B);
    expect(r.size()).toBe(0); // unordered does not create a sticky binding
  });

  it("pins an ordering key to one account and never migrates it", () => {
    const r = new DefaultRouter(new LeastInflightSelector());
    const first = r.route([W(A, 0), W(B, 5)], req, opts("path-1")); // picks A (fewest)
    expect(first).toBe(A);
    // Even though B now has fewer in-flight, the key stays pinned to A.
    const second = r.route([W(A, 9), W(B, 0)], req, opts("path-1"));
    expect(second).toBe(A);
    expect(r.size()).toBe(1);
  });

  it("evicts a sticky binding once all its refs are released", () => {
    const r = new DefaultRouter(new LeastInflightSelector());
    r.route([W(A, 0)], req, opts("path-1")); // ref 1
    r.route([W(A, 0)], req, opts("path-1")); // ref 2
    expect(r.size()).toBe(1);
    r.release("path-1"); // -> 1 ref left
    expect(r.size()).toBe(1);
    r.release("path-1"); // -> 0 refs, evict
    expect(r.size()).toBe(0);
  });

  it("prefers healthy candidates but falls back to all if none are healthy", () => {
    const r = new DefaultRouter(new LeastInflightSelector());
    // A is unhealthy with fewer in-flight; healthy-only pool should pick B.
    expect(r.route([W(A, 0, false), W(B, 3, true)], req, opts())).toBe(B);
    // all unhealthy -> fall back to the full set, picks fewest (A)
    const r2 = new DefaultRouter(new LeastInflightSelector());
    expect(r2.route([W(A, 0, false), W(B, 3, false)], req, opts())).toBe(A);
  });

  it("bind() pins and ref-counts for reattached txs", () => {
    const r = new DefaultRouter(new LeastInflightSelector());
    r.bind("path-1", A as Address);
    expect(r.size()).toBe(1);
    r.release("path-1");
    expect(r.size()).toBe(0);
  });
});
