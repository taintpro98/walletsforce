import type { Address, TxRequest, WalletState } from "../types";
import type { WalletSelector } from "./index";

/** Default selector: route to the account with the fewest in-flight txs.
 *  Beats round-robin when tx cost is uneven. */
export class LeastInflightSelector implements WalletSelector {
  pick(candidates: WalletState[], _req: TxRequest): Address {
    if (candidates.length === 0) throw new Error("no candidate wallets");
    return candidates.reduce((best, w) =>
      w.inflightCount < best.inflightCount ? w : best,
    ).address;
  }
}
