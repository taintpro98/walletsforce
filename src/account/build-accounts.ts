// Shared account-set construction. Both WalletForcePool and Supervisor build
// their OWN ManagedAccount instances from the same config — decoupled objects,
// but over the SAME cache+store, so the nonce lane (a cache primitive) and the
// durable record are shared. `emit` points every account at the shared EventBus.

import type { WalletConfig } from "../config";
import type { TxEventRecord } from "../types";
import type { PoolCache } from "../cache";
import type { PoolStore } from "../store";
import { ManagedAccount } from "./managed-account";

export function buildAccounts(
  config: WalletConfig,
  cache: PoolCache,
  store: PoolStore,
  emit: (rec: TxEventRecord) => void,
): Map<string, ManagedAccount> {
  const accounts = new Map<string, ManagedAccount>();
  for (const signer of config.signers) {
    accounts.set(
      signer.address.toLowerCase(),
      new ManagedAccount({
        signer,
        chainClient: config.chainClient,
        feeOracle: config.feeOracle,
        chainId: config.chainId,
        ownerId: config.ownerId,
        confirmations: config.confirmations ?? 1,
        stuckAfterMs: config.stuckAfterMs ?? 30_000,
        maxAttempts: config.maxAttempts ?? 5,
        maxInflight: config.maxInflightPerAccount ?? 512,
        emit,
        cache,
        store,
        logger: config.logger,
      }),
    );
  }
  return accounts;
}
