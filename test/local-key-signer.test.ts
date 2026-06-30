import { describe, it, expect } from "vitest";
import { parseTransaction } from "viem";
import { LocalKeySigner } from "../src/signer";
import type { Hex, SignableTx } from "../src/types";

// Well-known Anvil/Hardhat test account #0 — public, never use with real funds.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const EXPECTED_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("LocalKeySigner", () => {
  it("derives the correct address from the private key", () => {
    const signer = new LocalKeySigner(PK);
    expect(signer.address).toBe(EXPECTED_ADDR);
  });

  it("signs a legacy tx that round-trips through parseTransaction", async () => {
    const signer = new LocalKeySigner(PK);
    const tx: SignableTx = {
      chainId: 1,
      nonce: 3,
      to: TO as `0x${string}`,
      gas: 21_000n,
      fees: { type: "legacy", gasPrice: 5_000_000_000n },
    };
    const raw = await signer.signTransaction(tx);
    const parsed = parseTransaction(raw);
    expect(parsed.type).toBe("legacy");
    expect(parsed.nonce).toBe(3);
    expect(parsed.chainId).toBe(1);
    expect(parsed.to?.toLowerCase()).toBe(TO.toLowerCase());
    expect(parsed.gasPrice).toBe(5_000_000_000n);
  });

  it("signs an eip1559 tx that round-trips through parseTransaction", async () => {
    const signer = new LocalKeySigner(PK);
    const tx: SignableTx = {
      chainId: 8453,
      nonce: 9,
      to: TO as `0x${string}`,
      data: "0xdeadbeef",
      value: 123n,
      gas: 50_000n,
      fees: { type: "eip1559", maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
    };
    const raw = await signer.signTransaction(tx);
    const parsed = parseTransaction(raw);
    expect(parsed.type).toBe("eip1559");
    expect(parsed.nonce).toBe(9);
    expect(parsed.chainId).toBe(8453);
    expect(parsed.value).toBe(123n);
    expect(parsed.maxFeePerGas).toBe(2_000_000_000n);
    expect(parsed.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  it("is deterministic: same input -> same raw tx", async () => {
    const signer = new LocalKeySigner(PK);
    const tx: SignableTx = {
      chainId: 1,
      nonce: 1,
      to: TO as `0x${string}`,
      gas: 21_000n,
      fees: { type: "legacy", gasPrice: 1n },
    };
    expect(await signer.signTransaction(tx)).toBe(await signer.signTransaction(tx));
  });
});
