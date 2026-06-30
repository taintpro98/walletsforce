// Maps a raw RPC/broadcast error to a stable class the engine acts on:
//   nonce-drift -> reseed the lane (on rebroadcast = already landed, treat as success)
//   transient   -> retry / failover
//   revert      -> terminal for that tx
//   fatal       -> unknown; surface, do not silently swallow
// Mirrors the isNonceDrift / isLogLimitError classifiers in apps/*.

import type { RpcErrorClass } from "../types";

const REVERT = ["execution reverted", "revert"];
const NONCE = [
  "nonce too low",
  "nonce too high",
  "nonce has already been used",
  "already known",
  "replacement transaction underpriced",
  "expected nonce",
];
const TRANSIENT = [
  "timeout",
  "timed out",
  "econn",
  "network",
  "fetch failed",
  "socket",
  "rate limit",
  "too many requests",
  "429",
  "502",
  "503",
  "504",
];

export function classifyRpcError(err: unknown): RpcErrorClass {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (REVERT.some((s) => msg.includes(s))) return "revert";
  if (NONCE.some((s) => msg.includes(s))) return "nonce-drift";
  if (TRANSIENT.some((s) => msg.includes(s))) return "transient";
  return "fatal";
}
