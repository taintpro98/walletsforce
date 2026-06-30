import { describe, it, expect } from "vitest";
import { PoolRegistry } from "../src/registry";
import { WalletForcePool } from "../src/pool";
import { LegacyFeeOracle } from "../src/fee";
import { FakeChainClient, FakeSigner, ADDR_A } from "./helpers";

function pool(chainId: number) {
  return new WalletForcePool({
    ownerId: "t",
    chainId,
    signers: [new FakeSigner(ADDR_A)],
    chainClient: new FakeChainClient(),
    feeOracle: new LegacyFeeOracle({ minGasPriceWei: 1n }),
  });
}

describe("PoolRegistry", () => {
  it("registers and retrieves pools by chain id", () => {
    const reg = new PoolRegistry();
    const p1 = pool(1);
    const p2 = pool(8453);
    reg.register(1, p1);
    reg.register(8453, p2);
    expect(reg.get(1)).toBe(p1);
    expect(reg.get(8453)).toBe(p2);
  });

  it("throws for an unregistered chain", () => {
    const reg = new PoolRegistry();
    expect(() => reg.get(999)).toThrow(/no walletsforce pool for chain 999/);
  });
});
