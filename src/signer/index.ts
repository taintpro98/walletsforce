// Seam 1 — custody. The engine builds a fully-specified tx (SignableTx, defined
// in ../types); the Signer does pure cryptography and returns raw broadcast-ready
// bytes. Swap per environment: local key (dev), KMS/HSM/remote (prod).

import type { Address, Hex, SignableTx } from "../types";

export interface Signer {
  readonly address: Address;
  /** Sign EXACTLY the given tx. Deterministic: same input -> same raw tx + hash.
   *  No re-fetching nonce/gas, no hidden state. */
  signTransaction(tx: SignableTx): Promise<Hex>;
}

export * from "./local-key.signer";
export * from "./hd-wallet.signer";
