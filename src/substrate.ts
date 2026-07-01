// The shared runtime that BOTH the Pool and the Supervisor operate on: the fast
// cache, the durable store, the event bus, AND the account set built over them.
// These are injected dependencies (singletons), NOT config — you build ONE substrate
// and pass it to both objects, so they share one working set: one nonce lane per
// account, one in-flight view, one event bus, and ONE set of ManagedAccount objects
// (no duplicate arrays, and nothing to diverge).
//
// Single-pod: `createSubstrate(config)` builds the default in-memory triple + accounts.
// Group mode: pass your Redis cache / SQL store as `external`; the bus + account set
// are still built here. Each pod builds its own substrate over the shared backends.

import { InMemoryCache, type PoolCache } from "./cache";
import { createStore, type PoolStore, type StoreConfig } from "./store";
import { InMemoryEventBus, type EventBus } from "./events";
import { buildAccounts, type ManagedAccount } from "./account";
import type { WalletConfig } from "./config";

export interface Substrate {
  cache: PoolCache;
  store: PoolStore;
  bus: EventBus;
  /** The owned account set — built ONCE and shared by the pool and the supervisor. */
  accounts: Map<string, ManagedAccount>;
}

export interface SubstrateOptions {
  /** Durable store: a factory descriptor (built via `createStore` — e.g.
   *  `{ kind: "sqlite", path }`) OR an injected `PoolStore` instance (to share one
   *  across substrates, or plug a custom impl). Default: `{ kind: "memory" }`. */
  store?: StoreConfig | PoolStore;
  /** Fast operational layer. Default: in-memory. */
  cache?: PoolCache;
  /** Event sink. Default: in-memory over the cache. */
  bus?: EventBus;
}

/** Build the shared substrate from config. The store is selected via the factory
 *  (memory by default; `{ kind: "sqlite", path }` for durability). The bus needs the
 *  cache (for sticky release) + ownerId; the account set is wired to emit into it. */
export function createSubstrate(config: WalletConfig, opts: SubstrateOptions = {}): Substrate {
  const cache = opts.cache ?? new InMemoryCache();
  const store = resolveStore(opts.store);
  const bus =
    opts.bus ?? new InMemoryEventBus({ cache, ownerId: config.ownerId, logger: config.logger });
  const accounts = buildAccounts(config, cache, store, (rec) => bus.handle(rec));
  return { cache, store, bus, accounts };
}

/** A descriptor is built via the factory; a PoolStore instance is used as-is. */
function resolveStore(store: StoreConfig | PoolStore | undefined): PoolStore {
  if (!store) return createStore({ kind: "memory" });
  return "kind" in store ? createStore(store) : store;
}
