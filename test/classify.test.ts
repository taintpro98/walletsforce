import { describe, it, expect } from "vitest";
import { classifyRpcError } from "../src/chain/classify";

describe("classifyRpcError", () => {
  it("classifies revert errors", () => {
    expect(classifyRpcError(new Error("execution reverted: bad"))).toBe("revert");
    expect(classifyRpcError(new Error("VM Exception: revert"))).toBe("revert");
  });

  it("classifies nonce-drift errors", () => {
    for (const m of [
      "nonce too low",
      "Nonce too high",
      "nonce has already been used",
      "already known",
      "replacement transaction underpriced",
      "expected nonce 7",
    ]) {
      expect(classifyRpcError(new Error(m))).toBe("nonce-drift");
    }
  });

  it("classifies transient errors", () => {
    for (const m of ["request timeout", "ECONNRESET", "fetch failed", "429 too many", "503"]) {
      expect(classifyRpcError(new Error(m))).toBe("transient");
    }
  });

  it("defaults to fatal for unknown errors", () => {
    expect(classifyRpcError(new Error("something weird"))).toBe("fatal");
  });

  it("accepts non-Error values", () => {
    expect(classifyRpcError("nonce too low")).toBe("nonce-drift");
    expect(classifyRpcError({ foo: 1 })).toBe("fatal");
  });

  it("is case-insensitive and gives revert precedence over everything", () => {
    // "reverted" + "timeout" both present -> revert wins (checked first)
    expect(classifyRpcError(new Error("execution REVERTED after timeout"))).toBe("revert");
  });
});
