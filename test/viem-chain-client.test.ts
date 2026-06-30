import { describe, it, expect } from "vitest";
import { createPublicClient, custom } from "viem";
import { ViemChainClient } from "../src/chain";
import type { Address, Hash } from "../src/types";

type Handler = (args: { method: string; params?: unknown }) => Promise<unknown>;

function vcc(handler: Handler): ViemChainClient {
  return new ViemChainClient(createPublicClient({ transport: custom({ request: handler }) }));
}

const HASH = ("0x" + "ab".repeat(32)) as Hash;
const ADDR = ("0x" + "33".repeat(20)) as Address;

const RECEIPT = {
  status: "0x1",
  blockNumber: "0x10",
  transactionHash: HASH,
  blockHash: "0x" + "cd".repeat(32),
  transactionIndex: "0x0",
  from: "0x" + "11".repeat(20),
  to: "0x" + "22".repeat(20),
  cumulativeGasUsed: "0x1",
  gasUsed: "0x1",
  effectiveGasPrice: "0x1",
  logs: [],
  logsBloom: "0x" + "00".repeat(256),
  type: "0x2",
  contractAddress: null,
};

describe("ViemChainClient", () => {
  it("returns null for an unmined tx (viem throws not-found internally)", async () => {
    const c = vcc(async ({ method }) => {
      if (method === "eth_getTransactionReceipt") return null;
      throw new Error("unexpected " + method);
    });
    expect(await c.getTransactionReceipt(HASH)).toBeNull();
  });

  it("maps a mined receipt to the pool's Receipt shape", async () => {
    const c = vcc(async ({ method }) => {
      if (method === "eth_getTransactionReceipt") return RECEIPT;
      throw new Error("unexpected " + method);
    });
    expect(await c.getTransactionReceipt(HASH)).toEqual({
      status: "success",
      blockNumber: 16n,
      transactionHash: HASH,
    });
  });

  it("reads block number, tx count and balance with correct types", async () => {
    const c = vcc(async ({ method }) => {
      switch (method) {
        case "eth_blockNumber":
          return "0x2a";
        case "eth_getTransactionCount":
          return "0x5";
        case "eth_getBalance":
          return "0xde0b6b3a7640000";
        default:
          throw new Error("unexpected " + method);
      }
    });
    expect(await c.getBlockNumber()).toBe(42n);
    expect(await c.getTransactionCount(ADDR, "pending")).toBe(5);
    expect(await c.getBalance(ADDR)).toBe(10n ** 18n);
  });

  it("returns the latest block base fee (eip1559 chain)", async () => {
    const withBase = vcc(async ({ method }) => {
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x64", transactions: [] };
      throw new Error("unexpected " + method);
    });
    expect(await withBase.getBaseFeePerGas()).toBe(100n);
  });

  it("returns null when the block has no base fee (legacy chain)", async () => {
    const legacy = vcc(async ({ method }) => {
      if (method === "eth_getBlockByNumber") return { transactions: [] };
      throw new Error("unexpected " + method);
    });
    expect(await legacy.getBaseFeePerGas()).toBeNull();
  });

  it("re-throws non-not-found errors from getTransactionReceipt", async () => {
    const c = vcc(async ({ method }) => {
      if (method === "eth_getTransactionReceipt") throw new Error("boom rpc down");
      throw new Error("unexpected " + method);
    });
    await expect(c.getTransactionReceipt(HASH)).rejects.toThrow(/boom rpc down/);
  });
});
