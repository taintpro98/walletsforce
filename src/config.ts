import type { Address, Logger } from "./types";
import type { Signer } from "./signer";
import type { ChainClient } from "./chain";
import type { FeeOracle } from "./fee";
import type { WalletSelector } from "./routing";

/** Shared identity + account-construction inputs. Both the Pool and the Supervisor
 *  build their own ManagedAccount set from this. It carries POLICY only — the shared
 *  infrastructure singletons (cache, store, event bus) are NOT config; they're the
 *  injected `Substrate` dependency (see `./substrate`). The pool- and supervisor-
 *  specific knobs live in the extended configs below. */
export interface WalletConfig {
  /** Static-partition owner id. This instance owns exactly `signers`. */
  ownerId: string;
  chainId: number;
  /** The owned account set — one nonce lane each. */
  signers: Signer[];
  chainClient: ChainClient;
  feeOracle: FeeOracle;
  /** Confirmation depth before a tx is "confirmed". Default 1. */
  confirmations?: number;
  /** Unmined this long (ms) -> bump + replace (used by the confirm tick). */
  stuckAfterMs?: number;
  /** Replacement attempts before "failed". */
  maxAttempts?: number;
  /** Max in-flight (queued + unconfirmed) txs per account. `submit` throws when an
   *  account is at the cap — backpressure that bounds memory under load. Default 512. */
  maxInflightPerAccount?: number;
  logger?: Logger;
}

/** Config for `WalletForcePool` — the submit surface. Adds routing; carries none of
 *  the reconciler knobs (a submit pod never funds accounts or runs the tick). */
export interface WalletPoolConfig extends WalletConfig {
  /** Default: least-inflight. */
  selector?: WalletSelector;
}

/** Config for `Supervisor` — the reconciler. Adds the tick cadence and the balance
 *  POLICY (threshold + low-balance hook) that only the supervisor uses. The auto-refill
 *  `funder` is NOT here — it's a caller-owned service object (holds a treasury signer,
 *  does I/O), so it's injected as a constructor param, not carried as config. */
export interface SupervisorConfig extends WalletConfig {
  /** Confirm/refresh tick cadence (ms). Default 4000. */
  confirmTickMs?: number;
  /** Below this -> account marked unhealthy, dropped from rotation. */
  minBalanceWei?: bigint;
  onLowBalance?: (w: { address: Address; balanceWei: bigint }) => void;
}
