// Shared signing: turn a walletsforce SignableTx into a raw, broadcast-ready tx
// using any viem local account. Used by LocalKeySigner and HDWalletSigner.

import type { LocalAccount } from "viem";
import type { Hex, SignableTx } from "../types";

export function signSignableTx(account: LocalAccount, tx: SignableTx): Promise<Hex> {
  const base = {
    chainId: tx.chainId,
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: tx.gas,
  };

  if (tx.fees.type === "legacy") {
    return account.signTransaction({ ...base, type: "legacy", gasPrice: tx.fees.gasPrice });
  }
  return account.signTransaction({
    ...base,
    type: "eip1559",
    maxFeePerGas: tx.fees.maxFeePerGas,
    maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas,
  });
}
