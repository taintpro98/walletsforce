// Default in-memory PoolStore — the two tables held as Maps. This is walletsforce's
// original behaviour: nothing survives a crash. Terminal transactions are dropped
// (not retained as history) so memory stays bounded. Swap in a SQL store to persist.

import type { PoolStore } from "./interface";
import type { AccountRecord, TransactionRecord } from "./models";
import { isTerminal } from "./models";

const accountKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

export class InMemoryStore implements PoolStore {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly transactions = new Map<string, TransactionRecord>(); // by idempotencyKey

  async upsertAccount(rec: AccountRecord): Promise<void> {
    this.accounts.set(accountKey(rec.chainId, rec.address), rec);
  }

  async loadAccounts(ownerId: string, chainId: number): Promise<AccountRecord[]> {
    return [...this.accounts.values()].filter((a) => a.ownerId === ownerId && a.chainId === chainId);
  }

  async upsertTransaction(rec: TransactionRecord): Promise<void> {
    // Bounded memory: a terminal tx is removed rather than retained as history.
    if (isTerminal(rec.status)) this.transactions.delete(rec.idempotencyKey);
    else this.transactions.set(rec.idempotencyKey, rec);
  }

  async loadActiveTransactions(ownerId: string, chainId: number): Promise<TransactionRecord[]> {
    return [...this.transactions.values()].filter(
      (t) => t.ownerId === ownerId && t.chainId === chainId && !isTerminal(t.status),
    );
  }
}
