import { describe, it, expect } from "vitest";
import { LegacyFeeOracle, Eip1559FeeOracle, DEFAULT_BUMP_NUM, DEFAULT_BUMP_DEN } from "../src/fee";
import { FakeChainClient } from "./helpers";

const ctx = (attempt = 0) => ({ chainId: 1, attempt, client: new FakeChainClient() });

describe("LegacyFeeOracle", () => {
  it("estimates the configured floor", async () => {
    const o = new LegacyFeeOracle({ minGasPriceWei: 5n });
    expect(await o.estimate(ctx())).toEqual({ type: "legacy", gasPrice: 5n });
  });

  it("bumps by the default +12.5%", async () => {
    const o = new LegacyFeeOracle({ minGasPriceWei: 1n });
    const bumped = await o.bump({ type: "legacy", gasPrice: 1000n }, ctx(1));
    expect(bumped).toEqual({ type: "legacy", gasPrice: (1000n * DEFAULT_BUMP_NUM) / DEFAULT_BUMP_DEN });
  });

  it("never bumps below the floor", async () => {
    const o = new LegacyFeeOracle({ minGasPriceWei: 5_000n });
    const bumped = await o.bump({ type: "legacy", gasPrice: 10n }, ctx(1));
    expect(bumped).toEqual({ type: "legacy", gasPrice: 5_000n });
  });

  it("honours a custom bump ratio", async () => {
    const o = new LegacyFeeOracle({ minGasPriceWei: 1n, bumpNum: 2n, bumpDen: 1n });
    const bumped = await o.bump({ type: "legacy", gasPrice: 100n }, ctx(1));
    expect(bumped).toEqual({ type: "legacy", gasPrice: 200n });
  });

  it("refuses to bump eip1559 fees", async () => {
    const o = new LegacyFeeOracle({ minGasPriceWei: 1n });
    await expect(
      o.bump({ type: "eip1559", maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, ctx()),
    ).rejects.toThrow(/cannot bump eip1559/);
  });
});

describe("Eip1559FeeOracle", () => {
  it("estimates maxFee = baseFee * headroom + tip (default 2x)", async () => {
    const o = new Eip1559FeeOracle({ priorityFeeWei: 3n });
    const c = new FakeChainClient();
    c.baseFee = 100n;
    const fees = await o.estimate({ chainId: 1, attempt: 0, client: c });
    expect(fees).toEqual({ type: "eip1559", maxFeePerGas: 203n, maxPriorityFeePerGas: 3n });
  });

  it("treats a null baseFee as zero", async () => {
    const o = new Eip1559FeeOracle({ priorityFeeWei: 7n });
    const c = new FakeChainClient();
    c.baseFee = null;
    const fees = await o.estimate({ chainId: 1, attempt: 0, client: c });
    expect(fees).toEqual({ type: "eip1559", maxFeePerGas: 7n, maxPriorityFeePerGas: 7n });
  });

  it("respects a custom headroom multiplier", async () => {
    const o = new Eip1559FeeOracle({ priorityFeeWei: 0n, baseFeeHeadroomNum: 3n, baseFeeHeadroomDen: 1n });
    const c = new FakeChainClient();
    c.baseFee = 50n;
    const fees = await o.estimate({ chainId: 1, attempt: 0, client: c });
    expect(fees).toEqual({ type: "eip1559", maxFeePerGas: 150n, maxPriorityFeePerGas: 0n });
  });

  it("bumps both fee fields by +12.5%", async () => {
    const o = new Eip1559FeeOracle({ priorityFeeWei: 1n });
    const bumped = await o.bump(
      { type: "eip1559", maxFeePerGas: 1000n, maxPriorityFeePerGas: 200n },
      ctx(1),
    );
    expect(bumped).toEqual({ type: "eip1559", maxFeePerGas: 1125n, maxPriorityFeePerGas: 225n });
  });

  it("refuses to bump legacy fees", async () => {
    const o = new Eip1559FeeOracle({ priorityFeeWei: 1n });
    await expect(o.bump({ type: "legacy", gasPrice: 1n }, ctx())).rejects.toThrow(/cannot bump legacy/);
  });
});
