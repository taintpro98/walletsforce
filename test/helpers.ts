// Shared test doubles. These implement the real seam interfaces so tests
// exercise the engine without touching a network or real crypto.

import type { ChainClient } from "../src/chain";
import type { Signer } from "../src/signer";
import type { Address, Hash, Hex, SignableTx, Receipt, RpcErrorClass } from "../src/types";
import { classifyRpcError } from "../src/chain/classify";

export const ADDR_A = "0x000000000000000000000000000000000000000A" as Address;
export const ADDR_B = "0x000000000000000000000000000000000000000b" as Address;

export function hash(seed: string): Hash {
  return ("0x" + seed.repeat(64).slice(0, 64)) as Hash;
}

/** A scriptable ChainClient. Override any method via opts; sensible defaults
 *  cover the happy path. Records calls for assertions. */
export class FakeChainClient implements ChainClient {
  txCount = 0;
  baseFee: bigint | null = 0n;
  balance = 10n ** 18n;
  blockNumber = 100n;
  receipt: Receipt | null = null;
  sent: Hex[] = [];
  sendImpl: ((raw: Hex) => Promise<Hash>) | null = null;

  async getTransactionCount(_addr: Address, _tag: "pending" | "latest"): Promise<number> {
    return this.txCount;
  }
  async estimateGas(_tx: SignableTx): Promise<bigint> {
    return 21_000n;
  }
  async getBalance(_addr: Address): Promise<bigint> {
    return this.balance;
  }
  async getBaseFeePerGas(): Promise<bigint | null> {
    return this.baseFee;
  }
  async sendRawTransaction(raw: Hex): Promise<Hash> {
    this.sent.push(raw);
    if (this.sendImpl) return this.sendImpl(raw);
    return hash(String(this.sent.length));
  }
  async getTransactionReceipt(_hash: Hash): Promise<Receipt | null> {
    return this.receipt;
  }
  async getBlockNumber(): Promise<bigint> {
    return this.blockNumber;
  }
  classifyError(err: unknown): RpcErrorClass {
    return classifyRpcError(err);
  }
}

/** A Signer that does no crypto: returns a deterministic raw payload encoding
 *  the nonce so tests can correlate. */
export class FakeSigner implements Signer {
  signed: SignableTx[] = [];
  constructor(readonly address: Address) {}
  async signTransaction(tx: SignableTx): Promise<Hex> {
    this.signed.push(tx);
    return ("0x" + tx.nonce.toString(16).padStart(2, "0")) as Hex;
  }
}
