// Cache layer — the fast operational/working set (nonce lane, in-flight txs,
// routing gauges + sticky bindings). In-memory for one pod; a Redis implementation
// of the same interface shares it across pods (group mode). Pairs with a PoolStore
// (the durable record).

export * from "./pool-cache";
export * from "./in-memory.cache";
