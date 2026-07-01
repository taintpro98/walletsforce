// The persistence model — the canonical table records, defined as zod schemas so
// they're both reusable (import the type) and validatable (parse a row you loaded, a
// record before writing, or data crossing a trust boundary). Types are inferred from
// the schemas, so the schema is the single source of truth.
//
// walletsforce's recoverable state maps to TWO tables:
//   accounts      — per-account mutable state (one row per owned account)
//   transactions  — one row per tx across its whole lifecycle
//
// bigints (balanceWei, value, gas, fee fields) are kept as `bigint` in the model;
// SQL adapters store them as TEXT (see SqliteStore). booleans map to 0/1, optional
// fields to NULL, and `fees` is flattened into fee_type + gas_price / max_fee_* cols.

import { z } from "zod";
import {
  addressSchema,
  hashSchema,
  hexSchema,
  feeFieldsSchema,
  txStatusSchema,
  metadataSchema,
} from "../types";

/* ─────────────────────────────────────────────────────────────────────────────
 * Table: accounts        PK (chain_id, address)
 *
 *   owner_id         TEXT     -- which pool instance owns this account (config.ownerId)
 *   chain_id         INTEGER
 *   address          TEXT     -- lowercased 0x address
 *   derivation_index INTEGER  -- BIP-44 index if HD-derived; NULL for raw-key/KMS signers
 *   nonce_cursor     INTEGER  -- next nonce to allocate (the NonceLane cursor)
 *   balance_wei      TEXT     -- last observed balance (bigint as string)
 *   healthy          INTEGER  -- 0 / 1
 *   updated_at       INTEGER  -- ms epoch
 * ───────────────────────────────────────────────────────────────────────────── */
export const accountRecordSchema = z.object({
  ownerId: z.string(),
  chainId: z.number(),
  address: addressSchema, // lowercased
  /** BIP-44 address index, when the signer is an HDWalletSigner. Undefined for
   *  raw-key (LocalKeySigner) or external (KMS/HSM) signers. */
  derivationIndex: z.number().optional(),
  nonceCursor: z.number(),
  balanceWei: z.bigint(),
  healthy: z.boolean(),
  updatedAt: z.number(),
});
export type AccountRecord = z.infer<typeof accountRecordSchema>;

/* ─────────────────────────────────────────────────────────────────────────────
 * Table: transactions    PK (idempotency_key)        INDEX (owner_id, chain_id, status)
 *
 *   idempotency_key TEXT PK, owner_id, chain_id, account, nonce,
 *   -- signable (kept so a stuck tx can be re-signed for replacement after a crash):
 *   to_address, data (nullable), value (bigint→TEXT, nullable), gas (bigint→TEXT),
 *   fee_type, gas_price / max_fee_per_gas / max_priority_fee_per_gas (bigint→TEXT),
 *   -- lifecycle:
 *   hash, status, attempts, submitted_at, mined_emitted (0/1),
 *   ordering_key (nullable), metadata (JSON, nullable), error (nullable),
 *   replaceable (0/1, nullable), updated_at
 *
 * Recovery set = rows WHERE status NOT IN ('confirmed','reverted','failed').
 * Terminal rows are retained as history by durable stores (the in-memory store
 * drops them to stay bounded).
 * ───────────────────────────────────────────────────────────────────────────── */
export const transactionRecordSchema = z.object({
  idempotencyKey: z.string(),
  ownerId: z.string(),
  chainId: z.number(),
  account: addressSchema, // lowercased
  nonce: z.number(),

  // signable — everything needed to re-sign the SAME nonce on replacement
  to: addressSchema,
  data: hexSchema.optional(),
  value: z.bigint().optional(),
  gas: z.bigint(),
  fees: feeFieldsSchema,

  // lifecycle
  hash: hashSchema,
  status: txStatusSchema,
  attempts: z.number(),
  submittedAt: z.number(),
  minedEmitted: z.boolean(),
  orderingKey: z.string().optional(),
  metadata: metadataSchema.optional(),
  error: z.string().optional(),
  /** false for legacy reattach()ed placeholders (no calldata → confirm-only).
   *  Defaults to true (full signable was persisted → replaceable). */
  replaceable: z.boolean().optional(),
  updatedAt: z.number(),
});
export type TransactionRecord = z.infer<typeof transactionRecordSchema>;

const TERMINAL: ReadonlySet<TransactionRecord["status"]> = new Set([
  "confirmed",
  "reverted",
  "failed",
] as const);

/** A terminal status never transitions again — the tx is done (confirmed) or dead
 *  (reverted/failed). The recovery set on boot is the non-terminal rows. */
export const isTerminal = (s: TransactionRecord["status"]): boolean => TERMINAL.has(s);
