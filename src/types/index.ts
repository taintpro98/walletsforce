// All walletsforce DATA types, defined as zod schemas with inferred TS types.
// Schemas are exported alongside the types so callers (and the engine, at its
// boundaries) can validate at runtime. Behavioral interfaces with methods
// (Signer, ChainClient, FeeOracle, Router, ...) are NOT data and live in their
// own modules — zod validates data, not behavior. `Logger` (below) is the one
// method-bearing interface kept here for convenience.

import { z } from "zod";
import {
  addressSchema,
  hexSchema,
  hashSchema,
  feeFieldsSchema,
  txEventSchema,
  metadataSchema,
} from "./primitives";

export * from "./primitives";

/** A chain-agnostic call the caller wants landed. The pool owns from/nonce/fees. */
export const txRequestSchema = z.object({
  to: addressSchema,
  data: hexSchema.optional(),
  value: z.bigint().optional(),
  gasLimit: z.bigint().optional(),
});
export type TxRequest = z.infer<typeof txRequestSchema>;

export const submitOptionsSchema = z.object({
  idempotencyKey: z.string().min(1),
  orderingKey: z.string().min(1).optional(),
  metadata: metadataSchema.optional(),
});
export type SubmitOptions = z.infer<typeof submitOptionsSchema>;

/** A fully-specified tx handed to a Signer. */
export const signableTxSchema = z.object({
  chainId: z.number().int().positive(),
  nonce: z.number().int().nonnegative(),
  to: addressSchema,
  data: hexSchema.optional(),
  value: z.bigint().optional(),
  gas: z.bigint(),
  fees: feeFieldsSchema,
});
export type SignableTx = z.infer<typeof signableTxSchema>;

/** What `submit()` resolves to, once the tx is broadcast. */
export const submitResultSchema = z.object({
  account: addressSchema,
  nonce: z.number().int().nonnegative(),
  hash: hashSchema,
  fees: feeFieldsSchema,
});
export type SubmitResult = z.infer<typeof submitResultSchema>;

/** Replayed by the caller on boot to resume tracking an in-flight tx. */
export const reattachInputSchema = z.object({
  idempotencyKey: z.string().min(1),
  account: addressSchema,
  nonce: z.number().int().nonnegative(),
  hash: hashSchema,
  fees: feeFieldsSchema,
  orderingKey: z.string().min(1).optional(),
  metadata: metadataSchema.optional(),
});
export type ReattachInput = z.infer<typeof reattachInputSchema>;

/** Emitted on every lifecycle transition; the caller persists these. */
export const txEventRecordSchema = z.object({
  idempotencyKey: z.string(),
  orderingKey: z.string().optional(),
  account: addressSchema,
  nonce: z.number().int().nonnegative(),
  hash: hashSchema,
  status: txEventSchema,
  fees: feeFieldsSchema,
  attempts: z.number().int().nonnegative(),
  metadata: metadataSchema.optional(),
  error: z.string().optional(),
  at: z.number(),
});
export type TxEventRecord = z.infer<typeof txEventRecordSchema>;

/** Per-account snapshot for routing, health, and metrics. */
export const walletStateSchema = z.object({
  address: addressSchema,
  inflightCount: z.number().int().nonnegative(),
  nonceCursor: z.number().int().nonnegative(),
  balanceWei: z.bigint(),
  healthy: z.boolean(),
});
export type WalletState = z.infer<typeof walletStateSchema>;

/** A transaction receipt as the pool needs it. */
export const receiptSchema = z.object({
  status: z.enum(["success", "reverted"]),
  blockNumber: z.bigint(),
  transactionHash: hashSchema,
});
export type Receipt = z.infer<typeof receiptSchema>;

export const rpcErrorClassSchema = z.enum([
  "nonce-drift",
  "transient",
  "revert",
  "fatal",
]);
export type RpcErrorClass = z.infer<typeof rpcErrorClassSchema>;

/** Behavioral — not a data shape, so not a zod schema. */
export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}
