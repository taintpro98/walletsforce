// EIP-1559 oracle: maxFee = baseFee * headroom + tip. baseFee is read through the
// ChainClient so this stays RPC-agnostic.

import type { FeeFields } from "../types";
import type { FeeOracle, FeeContext } from "./index";
import { DEFAULT_BUMP_NUM, DEFAULT_BUMP_DEN } from "./index";

export interface Eip1559FeeOracleOptions {
  /** Priority fee / tip (wei). */
  priorityFeeWei: bigint;
  /** Base-fee headroom multiplier, default 2x. */
  baseFeeHeadroomNum?: bigint;
  baseFeeHeadroomDen?: bigint;
  bumpNum?: bigint;
  bumpDen?: bigint;
}

export class Eip1559FeeOracle implements FeeOracle {
  constructor(private readonly opts: Eip1559FeeOracleOptions) {}

  async estimate(ctx: FeeContext): Promise<FeeFields> {
    const base = (await ctx.client.getBaseFeePerGas()) ?? 0n;
    const hNum = this.opts.baseFeeHeadroomNum ?? 2n;
    const hDen = this.opts.baseFeeHeadroomDen ?? 1n;
    const tip = this.opts.priorityFeeWei;
    return {
      type: "eip1559",
      maxFeePerGas: (base * hNum) / hDen + tip,
      maxPriorityFeePerGas: tip,
    };
  }

  async bump(previous: FeeFields, _ctx: FeeContext): Promise<FeeFields> {
    if (previous.type !== "eip1559") {
      throw new Error("Eip1559FeeOracle cannot bump legacy fees");
    }
    const num = this.opts.bumpNum ?? DEFAULT_BUMP_NUM;
    const den = this.opts.bumpDen ?? DEFAULT_BUMP_DEN;
    return {
      type: "eip1559",
      maxFeePerGas: (previous.maxFeePerGas * num) / den,
      maxPriorityFeePerGas: (previous.maxPriorityFeePerGas * num) / den,
    };
  }
}
