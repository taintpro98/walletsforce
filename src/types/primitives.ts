// Leaf zod primitives. Inlined (not imported from a shared package) so
// walletsforce stays self-contained and extractable. The .transform casts to the
// 0x-prefixed template type so inferred types stay viem-compatible.

import { z } from "zod";

/** 0x-prefixed 20-byte EVM address. */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address")
  .transform((s) => s as `0x${string}`);
export type Address = z.infer<typeof addressSchema>;

/** Arbitrary-length 0x-prefixed hex bytes (calldata, raw tx). */
export const hexSchema = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed hex bytes")
  .transform((s) => s as `0x${string}`);
export type Hex = z.infer<typeof hexSchema>;

/** 0x-prefixed 32-byte value (tx hash). */
export const hashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hash")
  .transform((s) => s as `0x${string}`);
export type Hash = z.infer<typeof hashSchema>;

/** legacy gasPrice OR the EIP-1559 pair — discriminated on `type`. */
export const feeFieldsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("legacy"), gasPrice: z.bigint() }),
  z.object({
    type: z.literal("eip1559"),
    maxFeePerGas: z.bigint(),
    maxPriorityFeePerGas: z.bigint(),
  }),
]);
export type FeeFields = z.infer<typeof feeFieldsSchema>;

/** The status a transaction row is PERSISTED as, across its lifecycle. No "replaced":
 *  a fee-bump re-broadcasts at the SAME nonce, so the row returns to "broadcast" —
 *  "replaced" is only an emitted event, never a stored status. */
export const txStatusSchema = z.enum([
  "pending", // write-ahead: signed/intended, persisted BEFORE broadcast (internal; never emitted)
  "broadcast",
  "mined",
  "confirmed",
  "reverted",
  "failed",
]);
export type TxStatus = z.infer<typeof txStatusSchema>;

/** The lifecycle events a subscriber can observe (`on` / `waitForConfirmation`).
 *  Differs from TxStatus: no "pending" (internal write-ahead, never emitted); adds
 *  "replaced" (a fee-bump notification, which is never a persisted row status). */
export const txEventSchema = z.enum([
  "broadcast",
  "mined",
  "confirmed",
  "replaced",
  "reverted",
  "failed",
]);
export type TxEvent = z.infer<typeof txEventSchema>;

/** Terminal statuses/events — the tx is done (confirmed) or dead (reverted/failed).
 *  In both TxStatus and TxEvent, so usable where a value must be persisted AND emitted. */
export type TerminalStatus = "confirmed" | "reverted" | "failed";

/** Opaque caller metadata, echoed back on events. */
export const metadataSchema = z.record(z.string(), z.unknown());
