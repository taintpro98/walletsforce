// A durable PoolStore backed by SQLite (Node's built-in `node:sqlite`). Gives crash
// recovery: accounts + transactions survive a restart, and `pool.restore()` replays
// the non-terminal txs. Unlike the in-memory store, terminal rows are RETAINED as
// history (prune per your own retention policy).
//
// `node:sqlite` is loaded lazily (createRequire) so callers using only the in-memory
// store never touch it. Requires Node >= 22.5 (where `node:sqlite` landed).
//
// bigints (balanceWei, value, gas, fee fields) are stored as TEXT; booleans as 0/1;
// metadata as JSON; fees flattened into fee_type + gas_price / max_fee_* columns.

import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Address, Hash, Hex, FeeFields } from "../types";
import type { PoolStore } from "./interface";
import type { AccountRecord, TransactionRecord } from "./models";

const require = createRequire(import.meta.url);

const DDL = `
CREATE TABLE IF NOT EXISTS accounts (
  owner_id         TEXT    NOT NULL,
  chain_id         INTEGER NOT NULL,
  address          TEXT    NOT NULL,
  derivation_index INTEGER,
  nonce_cursor     INTEGER NOT NULL,
  balance_wei      TEXT    NOT NULL,
  healthy          INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address)
);
CREATE TABLE IF NOT EXISTS transactions (
  idempotency_key          TEXT PRIMARY KEY,
  owner_id                 TEXT    NOT NULL,
  chain_id                 INTEGER NOT NULL,
  account                  TEXT    NOT NULL,
  nonce                    INTEGER NOT NULL,
  to_address               TEXT    NOT NULL,
  data                     TEXT,
  value                    TEXT,
  gas                      TEXT    NOT NULL,
  fee_type                 TEXT    NOT NULL,
  gas_price                TEXT,
  max_fee_per_gas          TEXT,
  max_priority_fee_per_gas TEXT,
  hash                     TEXT    NOT NULL,
  status                   TEXT    NOT NULL,
  attempts                 INTEGER NOT NULL,
  submitted_at             INTEGER NOT NULL,
  mined_emitted            INTEGER NOT NULL,
  ordering_key             TEXT,
  metadata                 TEXT,
  error                    TEXT,
  replaceable              INTEGER,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tx_owner_chain_status ON transactions (owner_id, chain_id, status);
`;

// WAL + synchronous=NORMAL: fsync at checkpoint instead of every commit — the single
// biggest write-throughput lever. The durability window (a few last commits on an OS
// crash) is acceptable because the pool reconciles from the store on boot via restore().
// busy_timeout lets a second connection wait out the single writer instead of erroring.
// (No-ops harmlessly for ":memory:", which can't use WAL.)
const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
`;

const UPSERT_ACCOUNT_SQL = `
INSERT INTO accounts (owner_id, chain_id, address, derivation_index, nonce_cursor, balance_wei, healthy, updated_at)
VALUES ($owner_id, $chain_id, $address, $derivation_index, $nonce_cursor, $balance_wei, $healthy, $updated_at)
ON CONFLICT(chain_id, address) DO UPDATE SET
  owner_id=excluded.owner_id, derivation_index=excluded.derivation_index,
  nonce_cursor=excluded.nonce_cursor, balance_wei=excluded.balance_wei,
  healthy=excluded.healthy, updated_at=excluded.updated_at`;

const LOAD_ACCOUNTS_SQL = `SELECT * FROM accounts WHERE owner_id = ? AND chain_id = ?`;

const UPSERT_TX_SQL = `
INSERT INTO transactions (
  idempotency_key, owner_id, chain_id, account, nonce, to_address, data, value, gas,
  fee_type, gas_price, max_fee_per_gas, max_priority_fee_per_gas,
  hash, status, attempts, submitted_at, mined_emitted, ordering_key, metadata, error, replaceable, updated_at)
VALUES (
  $idempotency_key, $owner_id, $chain_id, $account, $nonce, $to_address, $data, $value, $gas,
  $fee_type, $gas_price, $max_fee_per_gas, $max_priority_fee_per_gas,
  $hash, $status, $attempts, $submitted_at, $mined_emitted, $ordering_key, $metadata, $error, $replaceable, $updated_at)
ON CONFLICT(idempotency_key) DO UPDATE SET
  owner_id=excluded.owner_id, chain_id=excluded.chain_id, account=excluded.account, nonce=excluded.nonce,
  to_address=excluded.to_address, data=excluded.data, value=excluded.value, gas=excluded.gas,
  fee_type=excluded.fee_type, gas_price=excluded.gas_price, max_fee_per_gas=excluded.max_fee_per_gas,
  max_priority_fee_per_gas=excluded.max_priority_fee_per_gas, hash=excluded.hash, status=excluded.status,
  attempts=excluded.attempts, submitted_at=excluded.submitted_at, mined_emitted=excluded.mined_emitted,
  ordering_key=excluded.ordering_key, metadata=excluded.metadata, error=excluded.error,
  replaceable=excluded.replaceable, updated_at=excluded.updated_at`;

const LOAD_ACTIVE_TX_SQL = `
SELECT * FROM transactions
WHERE owner_id = ? AND chain_id = ? AND status NOT IN ('confirmed','reverted','failed')`;

// SQLite row shapes (TEXT/INTEGER/NULL as returned by node:sqlite).
interface AccountRow {
  owner_id: string; chain_id: number; address: string; derivation_index: number | null;
  nonce_cursor: number; balance_wei: string; healthy: number; updated_at: number;
}
interface TxRow {
  idempotency_key: string; owner_id: string; chain_id: number; account: string; nonce: number;
  to_address: string; data: string | null; value: string | null; gas: string;
  fee_type: string; gas_price: string | null; max_fee_per_gas: string | null; max_priority_fee_per_gas: string | null;
  hash: string; status: string; attempts: number; submitted_at: number; mined_emitted: number;
  ordering_key: string | null; metadata: string | null; error: string | null;
  replaceable: number | null; updated_at: number;
}

const bool = (n: number | null): boolean => n === 1;
const feesToRow = (f: FeeFields) => ({
  fee_type: f.type,
  gas_price: f.type === "legacy" ? String(f.gasPrice) : null,
  max_fee_per_gas: f.type === "eip1559" ? String(f.maxFeePerGas) : null,
  max_priority_fee_per_gas: f.type === "eip1559" ? String(f.maxPriorityFeePerGas) : null,
});
const rowToFees = (r: TxRow): FeeFields =>
  r.fee_type === "legacy"
    ? { type: "legacy", gasPrice: BigInt(r.gas_price!) }
    : { type: "eip1559", maxFeePerGas: BigInt(r.max_fee_per_gas!), maxPriorityFeePerGas: BigInt(r.max_priority_fee_per_gas!) };

export class SqliteStore implements PoolStore {
  private readonly db: DatabaseSync;

  // Statements prepared ONCE (parse + plan) and reused across calls — a re-prepare
  // per upsert/load is pure overhead in the durable hot path.
  private readonly upsertAccountStmt: StatementSync;
  private readonly loadAccountsStmt: StatementSync;
  private readonly upsertTxStmt: StatementSync;
  private readonly loadActiveTxStmt: StatementSync;

  /** @param path a file path for durability (e.g. "walletsforce.sqlite"), or ":memory:"
   *  for an ephemeral per-connection DB (tests). */
  constructor(path: string) {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    this.db = new DatabaseSync(path);
    this.db.exec(PRAGMAS);
    this.db.exec(DDL);
    this.upsertAccountStmt = this.db.prepare(UPSERT_ACCOUNT_SQL);
    this.loadAccountsStmt = this.db.prepare(LOAD_ACCOUNTS_SQL);
    this.upsertTxStmt = this.db.prepare(UPSERT_TX_SQL);
    this.loadActiveTxStmt = this.db.prepare(LOAD_ACTIVE_TX_SQL);
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }

  async upsertAccount(rec: AccountRecord): Promise<void> {
    this.upsertAccountStmt
      .run({
        owner_id: rec.ownerId,
        chain_id: rec.chainId,
        address: rec.address,
        derivation_index: rec.derivationIndex ?? null,
        nonce_cursor: rec.nonceCursor,
        balance_wei: String(rec.balanceWei),
        healthy: rec.healthy ? 1 : 0,
        updated_at: rec.updatedAt,
      });
  }

  async loadAccounts(ownerId: string, chainId: number): Promise<AccountRecord[]> {
    const rows = this.loadAccountsStmt.all(ownerId, chainId) as unknown as AccountRow[];
    return rows.map((r) => ({
      ownerId: r.owner_id,
      chainId: r.chain_id,
      address: r.address as Address,
      derivationIndex: r.derivation_index ?? undefined,
      nonceCursor: r.nonce_cursor,
      balanceWei: BigInt(r.balance_wei),
      healthy: bool(r.healthy),
      updatedAt: r.updated_at,
    }));
  }

  async upsertTransaction(rec: TransactionRecord): Promise<void> {
    // Durable store retains terminal rows as history (unlike the in-memory store).
    const fees = feesToRow(rec.fees);
    this.upsertTxStmt
      .run({
        idempotency_key: rec.idempotencyKey,
        owner_id: rec.ownerId,
        chain_id: rec.chainId,
        account: rec.account,
        nonce: rec.nonce,
        to_address: rec.to,
        data: rec.data ?? null,
        value: rec.value === undefined ? null : String(rec.value),
        gas: String(rec.gas),
        ...fees,
        hash: rec.hash,
        status: rec.status,
        attempts: rec.attempts,
        submitted_at: rec.submittedAt,
        mined_emitted: rec.minedEmitted ? 1 : 0,
        ordering_key: rec.orderingKey ?? null,
        metadata: rec.metadata === undefined ? null : JSON.stringify(rec.metadata),
        error: rec.error ?? null,
        replaceable: rec.replaceable === undefined ? null : rec.replaceable ? 1 : 0,
        updated_at: rec.updatedAt,
      });
  }

  async loadActiveTransactions(ownerId: string, chainId: number): Promise<TransactionRecord[]> {
    const rows = this.loadActiveTxStmt.all(ownerId, chainId) as unknown as TxRow[];
    return rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      ownerId: r.owner_id,
      chainId: r.chain_id,
      account: r.account as Address,
      nonce: r.nonce,
      to: r.to_address as Address,
      data: (r.data ?? undefined) as Hex | undefined,
      value: r.value === null ? undefined : BigInt(r.value),
      gas: BigInt(r.gas),
      fees: rowToFees(r),
      hash: r.hash as Hash,
      status: r.status as TransactionRecord["status"],
      attempts: r.attempts,
      submittedAt: r.submitted_at,
      minedEmitted: bool(r.mined_emitted),
      orderingKey: r.ordering_key ?? undefined,
      metadata: r.metadata === null ? undefined : (JSON.parse(r.metadata) as Record<string, unknown>),
      error: r.error ?? undefined,
      replaceable: r.replaceable === null ? undefined : bool(r.replaceable),
      updatedAt: r.updated_at,
    }));
  }
}
