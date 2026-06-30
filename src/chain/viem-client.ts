// Default ChainClient over a viem Client. Uses the tree-shakeable action
// functions from `viem/actions` so the adapter stays decoupled from whichever
// actions are attached to the client the caller passes in, and robust across
// viem minor versions. classifyError is wired to the real classifier.

import {
  type Client,
  TransactionReceiptNotFoundError,
} from "viem";
import {
  estimateGas,
  getBalance,
  getBlock,
  getBlockNumber,
  getTransactionCount,
  getTransactionReceipt,
  sendRawTransaction,
} from "viem/actions";

import type { Address, Hash, Hex, SignableTx, Receipt, RpcErrorClass } from "../types";
import type { ChainClient } from "./index";
import { classifyRpcError } from "./classify";

export class ViemChainClient implements ChainClient {
  constructor(private readonly client: Client) {}

  async getTransactionCount(addr: Address, tag: "pending" | "latest"): Promise<number> {
    return getTransactionCount(this.client, { address: addr, blockTag: tag });
  }

  async estimateGas(tx: SignableTx): Promise<bigint> {
    // SignableTx carries no sender, so we estimate without `account`. `gas` on the
    // input is a placeholder (the engine calls this precisely to discover it).
    return estimateGas(this.client, {
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
  }

  async getBalance(addr: Address): Promise<bigint> {
    return getBalance(this.client, { address: addr });
  }

  async getBaseFeePerGas(): Promise<bigint | null> {
    const block = await getBlock(this.client, { blockTag: "latest" });
    return block.baseFeePerGas ?? null;
  }

  async sendRawTransaction(raw: Hex): Promise<Hash> {
    return sendRawTransaction(this.client, { serializedTransaction: raw });
  }

  async getTransactionReceipt(hash: Hash): Promise<Receipt | null> {
    try {
      const r = await getTransactionReceipt(this.client, { hash });
      return {
        status: r.status, // viem yields "success" | "reverted"
        blockNumber: r.blockNumber,
        transactionHash: r.transactionHash,
      };
    } catch (err) {
      // Not yet mined: viem throws rather than returning null. Honour the
      // ChainClient contract (null = pending). Re-throw anything else.
      if (err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    }
  }

  async getBlockNumber(): Promise<bigint> {
    return getBlockNumber(this.client);
  }

  classifyError(err: unknown): RpcErrorClass {
    return classifyRpcError(err);
  }
}
