// Default Funder: tops up drained pool accounts with native gas from a treasury
// account. Wire it into the pool via `funder` in WalletPoolConfig — the supervisor
// calls maybeTopUp() for every account that drops below `minBalanceWei`.
//
// Design notes:
//  - The treasury is itself an EVM account, so its sends go through a NonceLane
//    (gap-free, single-writer) — multiple accounts needing gas in the same tick
//    are funded sequentially without nonce collisions.
//  - One top-up in flight per recipient: a recipient stays in `pending` until a
//    later balance check shows it recovered, so we never double-fund while the
//    first top-up is still in the mempool.
//  - The treasury floor (`minTreasuryWei`) is honored — we never spend the
//    treasury below it (incl. the send's own gas), so a drained treasury fails
//    loudly via the logger instead of bricking itself.

import type { Address, SignableTx, Logger } from "../types";
import type { Signer } from "../signer";
import type { ChainClient } from "../chain";
import type { FeeOracle } from "../fee";
import type { Funder } from "./index";
import { NonceLane } from "../account/nonce-lane";

/** Gas for a plain native-value transfer. */
const TRANSFER_GAS = 21_000n;

export interface TreasuryFunderOptions {
  /** The treasury account that holds gas and funds the others. Keep it separate
   *  from the pool's signers. */
  signer: Signer;
  chainClient: ChainClient;
  /** Used to price the funding tx. Reuse the pool's oracle. */
  feeOracle: FeeOracle;
  chainId: number;
  /** Top each drained account up to (at least) this balance. Set it above the
   *  pool's `minBalanceWei` so a topped-up account clears the unhealthy threshold
   *  with headroom (avoids re-funding every tick). */
  targetBalanceWei: bigint;
  /** Never spend the treasury below this (the send's gas is also reserved on top).
   *  Default 0n. */
  minTreasuryWei?: bigint;
  logger?: Logger;
}

export class TreasuryFunder implements Funder {
  private readonly lane: NonceLane;
  /** recipients with a top-up currently in flight (one at a time each). */
  private readonly pending = new Set<string>();

  constructor(private readonly opts: TreasuryFunderOptions) {
    this.lane = new NonceLane(opts.signer.address, opts.chainClient);
  }

  async maybeTopUp(addr: Address): Promise<void> {
    const key = addr.toLowerCase();
    const { chainClient, feeOracle, signer, targetBalanceWei, logger } = this.opts;

    // Already recovered? clear any in-flight marker and stop.
    const balance = await chainClient.getBalance(addr);
    if (balance >= targetBalanceWei) {
      this.pending.delete(key);
      return;
    }
    // A top-up is already on the wire for this account — wait for it to land.
    if (this.pending.has(key)) return;

    const amount = targetBalanceWei - balance;

    // Price the send and make sure the treasury can afford it without breaching its floor.
    const fees = await feeOracle.estimate({ chainId: this.opts.chainId, attempt: 0, client: chainClient });
    const gasPriceWei = fees.type === "legacy" ? fees.gasPrice : fees.maxFeePerGas;
    const maxGasCost = TRANSFER_GAS * gasPriceWei;
    const floor = this.opts.minTreasuryWei ?? 0n;

    const treasuryBalance = await chainClient.getBalance(signer.address);
    if (treasuryBalance < amount + maxGasCost + floor) {
      logger?.error(
        `TreasuryFunder: insufficient treasury to fund ${addr} ` +
          `(need ${amount + maxGasCost} + floor ${floor}, have ${treasuryBalance})`,
      );
      return;
    }

    this.pending.add(key);
    try {
      await this.lane.withNextNonce(async (nonce) => {
        const signable: SignableTx = {
          chainId: this.opts.chainId,
          nonce,
          to: addr,
          value: amount,
          gas: TRANSFER_GAS,
          fees,
        };
        const raw = await signer.signTransaction(signable);
        const hash = await chainClient.sendRawTransaction(raw);
        logger?.info(`TreasuryFunder: sent ${amount} to ${addr} (nonce ${nonce}, tx ${hash})`);
        return hash;
      });
      // Leave `addr` in `pending` until a later balance check shows it recovered,
      // so we don't double-fund while this tx is still unconfirmed.
    } catch (err) {
      this.pending.delete(key); // broadcast failed — allow a retry next tick
      logger?.error(`TreasuryFunder: top-up of ${addr} failed`, err);
    }
  }
}
