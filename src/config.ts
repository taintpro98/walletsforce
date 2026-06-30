import type { Address, Logger } from "./types";
import type { Signer } from "./signer";
import type { ChainClient } from "./chain";
import type { FeeOracle } from "./fee";
import type { WalletSelector } from "./routing";

export interface WalletPoolConfig {
  /** Static-partition owner id. This instance owns exactly `signers`. */
  ownerId: string;
  chainId: number;
  /** The owned account set — one nonce lane each. */
  signers: Signer[];
  chainClient: ChainClient;
  feeOracle: FeeOracle;
  /** Default: least-inflight. */
  selector?: WalletSelector;
  /** Confirmation depth before a tx is "confirmed". Default 1. */
  confirmations?: number;
  /** Receipt poll cadence (ms). */
  confirmTickMs?: number;
  /** Unmined this long (ms) -> bump + replace. */
  stuckAfterMs?: number;
  /** Replacement attempts before "failed". */
  maxAttempts?: number;
  /** Max in-flight (queued + unconfirmed) txs per account. `submit` throws when an
   *  account is at the cap — backpressure that bounds memory under load. Default 512. */
  maxInflightPerAccount?: number;
  /** Below this -> account marked unhealthy, dropped from rotation. */
  minBalanceWei?: bigint;
  onLowBalance?: (w: { address: Address; balanceWei: bigint }) => void;
  logger?: Logger;
}
