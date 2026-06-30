// Seam 3 — the single chokepoint for node I/O. Isolating it keeps RPC concerns
// (failover, retries, rate-limiting) in one swappable place and walletsforce
// RPC-library-agnostic. Default impl: ViemChainClient.

import type { Address, Hash, Hex, SignableTx, Receipt, RpcErrorClass } from "../types";

export interface ChainClient {
  getTransactionCount(addr: Address, tag: "pending" | "latest"): Promise<number>;
  estimateGas(tx: SignableTx): Promise<bigint>;
  getBalance(addr: Address): Promise<bigint>;
  /** Latest base fee for the FeeOracle; null on legacy chains. */
  getBaseFeePerGas(): Promise<bigint | null>;
  /** Broadcast a signed tx. Idempotent: re-sending the same raw tx is safe. */
  sendRawTransaction(raw: Hex): Promise<Hash>;
  getTransactionReceipt(hash: Hash): Promise<Receipt | null>;
  getBlockNumber(): Promise<bigint>;
  /** Classify a raw RPC/broadcast error so the engine can react correctly. */
  classifyError(err: unknown): RpcErrorClass;
}

export * from "./classify";
export * from "./viem-client";
