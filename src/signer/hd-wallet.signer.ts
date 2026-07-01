// HD-wallet signer: derives one account from a BIP-39 mnemonic at the standard
// BIP-44 path m/44'/60'/0'/0/<index> (the same scheme an Ethereum HD wallet uses).
//
// One mnemonic seeds the whole pool: each signer is account `index`, and only the
// index needs to be persisted (in AccountRecord.derivationIndex) — the key is
// re-derived in memory from the mnemonic, never stored. Keep the mnemonic in a
// secret store / env, never in the DB.

import { mnemonicToAccount } from "viem/accounts";
import type { Address, Hex, SignableTx } from "../types";
import type { Signer } from "./index";
import { signSignableTx } from "./sign";

export class HDWalletSigner implements Signer {
  private readonly account: ReturnType<typeof mnemonicToAccount>;
  /** BIP-44 address index this signer derives — persist it to re-create the signer later. */
  readonly derivationIndex: number;

  constructor(mnemonic: string, index: number) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`HDWalletSigner: derivation index must be a non-negative integer, got ${index}`);
    }
    this.account = mnemonicToAccount(mnemonic, { addressIndex: index });
    this.derivationIndex = index;
  }

  get address(): Address {
    return this.account.address;
  }

  signTransaction(tx: SignableTx): Promise<Hex> {
    return signSignableTx(this.account, tx);
  }
}

/** Derive `count` signers from one mnemonic, at indices `startIndex … startIndex+count-1`. */
export function deriveHDSigners(mnemonic: string, count: number, startIndex = 0): HDWalletSigner[] {
  return Array.from({ length: count }, (_, i) => new HDWalletSigner(mnemonic, startIndex + i));
}
