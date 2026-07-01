// Store factory — selects a PoolStore implementation by mode. Keeps the
// `new InMemoryStore()` / `new SqliteStore(...)` decision in ONE place, so callers
// (and createSubstrate) pick durability declaratively instead of hardcoding a default.
//
//   createStore({ kind: "memory" })                       // ephemeral, one pod
//   createStore({ kind: "sqlite", path: "wf.sqlite" })    // durable, crash recovery

import type { PoolStore } from "./interface";
import { InMemoryStore } from "./in-memory.store";
import { SqliteStore } from "./sqlite.store";

export type StoreConfig =
  | { kind: "memory" }
  /** SQLite-backed durable store. `path` is a file (durable) or ":memory:" (ephemeral). */
  | { kind: "sqlite"; path: string };

export function createStore(config: StoreConfig): PoolStore {
  switch (config.kind) {
    case "memory":
      return new InMemoryStore();
    case "sqlite":
      return new SqliteStore(config.path);
    default: {
      // exhaustiveness guard — a new kind must be handled above
      const _never: never = config;
      throw new Error(`unknown store kind: ${JSON.stringify(_never)}`);
    }
  }
}
