// Legacy gasPrice oracle with a configurable floor. Covers chains that skip
// near-zero-gas txs (e.g. besu QBFT) and any non-1559 chain.

import type { FeeFields } from "../types";
import type { FeeOracle, FeeContext } from "./index";
import { DEFAULT_BUMP_NUM, DEFAULT_BUMP_DEN } from "./index";

export interface LegacyFeeOracleOptions {
  /** Minimum gasPrice (wei). Also the initial estimate. */
  minGasPriceWei: bigint;
  bumpNum?: bigint;
  bumpDen?: bigint;
}

export class LegacyFeeOracle implements FeeOracle {
  constructor(private readonly opts: LegacyFeeOracleOptions) {}

  async estimate(_ctx: FeeContext): Promise<FeeFields> {
    return { type: "legacy", gasPrice: this.opts.minGasPriceWei };
  }

  async bump(previous: FeeFields, _ctx: FeeContext): Promise<FeeFields> {
    if (previous.type !== "legacy") {
      throw new Error("LegacyFeeOracle cannot bump eip1559 fees");
    }
    const num = this.opts.bumpNum ?? DEFAULT_BUMP_NUM;
    const den = this.opts.bumpDen ?? DEFAULT_BUMP_DEN;
    const bumped = (previous.gasPrice * num) / den;
    return {
      type: "legacy",
      gasPrice: bumped > this.opts.minGasPriceWei ? bumped : this.opts.minGasPriceWei,
    };
  }
}
