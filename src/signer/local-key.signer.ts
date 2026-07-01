// Local private-key signer (default). Wraps a viem account; signs in-process.
// For dev / low-value use.

import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, SignableTx } from "../types";
import type { Signer } from "./index";
import { signSignableTx } from "./sign";

export class LocalKeySigner implements Signer {
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.account.address;
  }

  signTransaction(tx: SignableTx): Promise<Hex> {
    return signSignableTx(this.account, tx);
  }
}
