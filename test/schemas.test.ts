import { describe, it, expect } from "vitest";
import {
  addressSchema,
  hexSchema,
  hashSchema,
  feeFieldsSchema,
  txRequestSchema,
  submitOptionsSchema,
  receiptSchema,
} from "../src/types";

describe("primitive schemas", () => {
  it("accepts a valid address and rejects malformed ones", () => {
    expect(addressSchema.parse("0x" + "a".repeat(40))).toBe("0x" + "a".repeat(40));
    expect(() => addressSchema.parse("0x" + "a".repeat(39))).toThrow();
    expect(() => addressSchema.parse("zz" + "a".repeat(38))).toThrow();
  });

  it("hex must be 0x-prefixed even-length bytes", () => {
    expect(hexSchema.parse("0x")).toBe("0x");
    expect(hexSchema.parse("0xabcd")).toBe("0xabcd");
    expect(() => hexSchema.parse("0xabc")).toThrow(); // odd length
    expect(() => hexSchema.parse("abcd")).toThrow(); // no prefix
  });

  it("hash must be exactly 32 bytes", () => {
    expect(hashSchema.parse("0x" + "1".repeat(64))).toBeTypeOf("string");
    expect(() => hashSchema.parse("0x" + "1".repeat(63))).toThrow();
  });
});

describe("feeFieldsSchema (discriminated union)", () => {
  it("accepts legacy fees", () => {
    expect(feeFieldsSchema.parse({ type: "legacy", gasPrice: 5n })).toEqual({
      type: "legacy",
      gasPrice: 5n,
    });
  });
  it("accepts eip1559 fees", () => {
    const v = { type: "eip1559", maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
    expect(feeFieldsSchema.parse(v)).toEqual(v);
  });
  it("rejects a legacy shape carrying eip1559 fields only", () => {
    expect(() => feeFieldsSchema.parse({ type: "legacy", maxFeePerGas: 1n })).toThrow();
  });
  it("rejects an unknown discriminant", () => {
    expect(() => feeFieldsSchema.parse({ type: "blob", gasPrice: 1n })).toThrow();
  });
});

describe("txRequestSchema", () => {
  it("requires `to` and allows optional data/value/gasLimit", () => {
    expect(txRequestSchema.parse({ to: "0x" + "b".repeat(40) })).toBeTruthy();
    expect(() => txRequestSchema.parse({ data: "0x" })).toThrow();
  });
});

describe("submitOptionsSchema", () => {
  it("requires a non-empty idempotencyKey", () => {
    expect(submitOptionsSchema.parse({ idempotencyKey: "k" }).idempotencyKey).toBe("k");
    expect(() => submitOptionsSchema.parse({ idempotencyKey: "" })).toThrow();
    expect(() => submitOptionsSchema.parse({})).toThrow();
  });
});

describe("receiptSchema", () => {
  it("accepts success/reverted and rejects other statuses", () => {
    const ok = { status: "success", blockNumber: 1n, transactionHash: "0x" + "f".repeat(64) };
    expect(receiptSchema.parse(ok)).toEqual(ok);
    expect(() => receiptSchema.parse({ ...ok, status: "pending" })).toThrow();
  });
});
