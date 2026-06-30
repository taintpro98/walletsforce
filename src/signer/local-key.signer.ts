// Local private-key signer (default). Wraps a viem account; signs in-process.
// For dev / low-value use. Mirrors apps/*/signer/local-key.signer.ts.

import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, SignableTx } from "../types";
import type { Signer } from "./index";

export class LocalKeySigner implements Signer {
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.account.address;
  }

  async signTransaction(tx: SignableTx): Promise<Hex> {
    const base = {
      chainId: tx.chainId,
      nonce: tx.nonce,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
    };

    if (tx.fees.type === "legacy") {
      return this.account.signTransaction({
        ...base,
        type: "legacy",
        gasPrice: tx.fees.gasPrice,
      });
    }

    return this.account.signTransaction({
      ...base,
      type: "eip1559",
      maxFeePerGas: tx.fees.maxFeePerGas,
      maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas,
    });
  }
}
