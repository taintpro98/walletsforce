// Default ChainClient over a viem PublicClient. The RPC method bodies are stubbed
// (TODO) so the scaffold compiles without pinning to exact viem signatures — fill
// them using the patterns already proven in apps/dvn/src/{src,dst}-chain-client.ts.
// classifyError is wired to the real classifier.

import type { Address, Hash, Hex, SignableTx, Receipt, RpcErrorClass } from "../types";
import type { ChainClient } from "./index";
import { classifyRpcError } from "./classify";

/** Minimal surface this adapter needs from a viem PublicClient (kept loose so the
 *  scaffold does not over-constrain the viem version). */
export interface ViemPublicClientLike {
  // intentionally untyped here; the real adapter binds a concrete viem client.
  [method: string]: unknown;
}

export class ViemChainClient implements ChainClient {
  constructor(private readonly client: ViemPublicClientLike) {}

  async getTransactionCount(_addr: Address, _tag: "pending" | "latest"): Promise<number> {
    // TODO: this.client.getTransactionCount({ address, blockTag })
    throw new Error("ViemChainClient.getTransactionCount: not implemented");
  }

  async estimateGas(_tx: SignableTx): Promise<bigint> {
    // TODO: this.client.estimateGas({ account, to, data, value })
    throw new Error("ViemChainClient.estimateGas: not implemented");
  }

  async getBalance(_addr: Address): Promise<bigint> {
    // TODO: this.client.getBalance({ address })
    throw new Error("ViemChainClient.getBalance: not implemented");
  }

  async getBaseFeePerGas(): Promise<bigint | null> {
    // TODO: (await this.client.getBlock()).baseFeePerGas ?? null
    throw new Error("ViemChainClient.getBaseFeePerGas: not implemented");
  }

  async sendRawTransaction(_raw: Hex): Promise<Hash> {
    // TODO: this.client.sendRawTransaction({ serializedTransaction })
    throw new Error("ViemChainClient.sendRawTransaction: not implemented");
  }

  async getTransactionReceipt(_hash: Hash): Promise<Receipt | null> {
    // TODO: map this.client.getTransactionReceipt({ hash }) -> Receipt | null
    throw new Error("ViemChainClient.getTransactionReceipt: not implemented");
  }

  async getBlockNumber(): Promise<bigint> {
    // TODO: this.client.getBlockNumber()
    throw new Error("ViemChainClient.getBlockNumber: not implemented");
  }

  classifyError(err: unknown): RpcErrorClass {
    return classifyRpcError(err);
  }
}
