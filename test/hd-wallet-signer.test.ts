import { describe, it, expect } from "vitest";
import { parseTransaction } from "viem";
import { HDWalletSigner, deriveHDSigners } from "../src/signer";
import type { SignableTx } from "../src/types";

// The standard local-node dev mnemonic (Hardhat & Anvil). Its accounts are the
// well-known public test accounts — never use with real funds.
const MNEMONIC = "test test test test test test test test test test test junk";

// Known addresses for this mnemonic at m/44'/60'/0'/0/{0,1,2}.
const ADDR0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ADDR1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ADDR2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

describe("HDWalletSigner", () => {
  it("derives the canonical addresses for each index", () => {
    expect(new HDWalletSigner(MNEMONIC, 0).address).toBe(ADDR0);
    expect(new HDWalletSigner(MNEMONIC, 1).address).toBe(ADDR1);
    expect(new HDWalletSigner(MNEMONIC, 2).address).toBe(ADDR2);
  });

  it("exposes its derivationIndex", () => {
    expect(new HDWalletSigner(MNEMONIC, 7).derivationIndex).toBe(7);
  });

  it("rejects an invalid index", () => {
    expect(() => new HDWalletSigner(MNEMONIC, -1)).toThrow(/non-negative integer/);
    expect(() => new HDWalletSigner(MNEMONIC, 1.5)).toThrow(/non-negative integer/);
  });

  it("signs a tx that round-trips and is sent from the derived address", async () => {
    const signer = new HDWalletSigner(MNEMONIC, 1);
    const tx: SignableTx = {
      chainId: 8453,
      nonce: 4,
      to: ADDR2 as `0x${string}`,
      value: 5n,
      gas: 21_000n,
      fees: { type: "eip1559", maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
    };
    const raw = await signer.signTransaction(tx);
    const parsed = parseTransaction(raw);
    expect(parsed.type).toBe("eip1559");
    expect(parsed.nonce).toBe(4);
    expect(parsed.chainId).toBe(8453);
    expect(parsed.maxFeePerGas).toBe(2_000_000_000n);
  });

  it("deriveHDSigners produces sequential, distinct accounts", () => {
    const signers = deriveHDSigners(MNEMONIC, 3);
    expect(signers.map((s) => s.derivationIndex)).toEqual([0, 1, 2]);
    expect(signers.map((s) => s.address)).toEqual([ADDR0, ADDR1, ADDR2]);

    const fromTwo = deriveHDSigners(MNEMONIC, 2, 1);
    expect(fromTwo.map((s) => s.address)).toEqual([ADDR1, ADDR2]);
  });
});
