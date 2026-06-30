# walletsforce — architecture

A general-purpose, in-memory **EVM account pool**. You give it signer accounts and
a chain; you call `submit(tx)`. It routes the tx to an account, serializes that
account's nonce lane, signs, broadcasts, confirms, and replaces stuck txs.

> **The core idea:** 1 account = 1 nonce lane = the single-account sequential-nonce
> throughput ceiling. **N accounts = N independent lanes**, so you break that ceiling
> and confine head-of-line blocking to one lane.

---

## Landscape

```
                                  YOUR SERVICE
                                       │
                      submit(req, {idempotencyKey, orderingKey?})
                                       ▼
╔══════════════════════════════════════════════════════════════════════════════╗
║                          WalletForcePool  (facade)                             ║
║  · the only surface you call     · event bus (on/off + waitForConfirmation)    ║
║  · single supervisor loop (start/stop): confirm + balance/refill, one timer    ║
║                                                                                ║
║   ┌──────────────────┐  pick  ┌──────────────────────────────────────────┐    ║
║   │   Router          │──────▶ │  accounts: Map<addr, ManagedAccount>      │    ║
║   │  (DefaultRouter)  │  acct  │   ┌────────────────────────────────┐      │    ║
║   │ orderingKey?      │        │   │       ManagedAccount  (×N)       │      │   ║
║   │  ├ yes→ sticky    │        │   │   one address = one nonce lane   │      │   ║
║   │  │  (ref-counted) │        │   │  ┌──────────┐ inflight Map         │    │   ║
║   │  └ no → Selector  │        │   │  │ NonceLane│ <nonce, entry>        │    │   ║
║   │   (LeastInflight) │        │   │  │ mutex+cur│ pending-cap (backpr.) │    │   ║
║   └──────────────────┘        │   │  └──────────┘                      │     │   ║
║                               │   └────────────────────────────────┘      │    ║
║                               └──────────────────────────────────────────┘    ║
╚═════╤═══════════════╤════════════════╤════════════════╤═══════════════╤════════╝
   Seam 1          Seam 2           Seam 3          optional
      ▼               ▼                ▼                ▼
  ┌────────┐   ┌────────────┐  ┌────────────────┐  ┌──────────────────┐
  │ Signer │   │ FeeOracle  │  │  ChainClient   │  │     Funder       │
  │custody │   │price + bump│  │ read RPC +     │  │  auto-refill     │
  ├────────┤   ├────────────┤  │ broadcast      │  ├──────────────────┤
  │LocalKey│   │Legacy /    │  ├────────────────┤  │ TreasuryFunder   │
  │Signer  │   │Eip1559     │  │ ViemChainClient│  │  treasury → acct │
  │→ KMS   │   │→ custom    │  │ (viem/actions) │  └────────┬─────────┘
  └────────┘   └────────────┘  └───────┬────────┘           │ sends gas
                                       ▼                     │
                                ⛓  EVM CHAIN ◀───────────────┘
                               (viem = peerDependency)
```

---

## Components & responsibilities

| Component | Responsibility |
|---|---|
| **`WalletForcePool`** | Facade + event bus + supervisor loop. The only surface you touch. One pool per chain. |
| **`ManagedAccount`** | One per address — the unit of parallelism. Owns the send pipeline + the confirm/replace loop + the in-flight cap. |
| **`NonceLane`** | Async mutex + nonce allocator for one account. Serializes allocation+broadcast; advances the cursor only on success (no gaps). |
| **`Router` / `WalletSelector`** | Picks the account per request. Sticky (ref-counted) for `orderingKey`s; least-in-flight otherwise. |
| **`Signer`** *(seam 1)* | Custody. Signs a fully-specified tx; returns raw bytes. |
| **`FeeOracle`** *(seam 2)* | Gas pricing + replacement-bump policy. |
| **`ChainClient`** *(seam 3)* | The single chokepoint for node I/O (reads + broadcast + error classification). |
| **`Funder`** *(optional)* | Auto-refills drained accounts from a treasury account. |
| **`PoolStore`** *(optional)* | Sugar to mirror lifecycle events onto your own store. walletsforce persists nothing itself. |
| **`PoolRegistry`** | Thin multi-chain wrapper: one `WalletForcePool` per chain id. |

---

## Interfaces

### Facade — `WalletForcePool`

```ts
interface IWalletForcePool {
  start(): void;
  stop(): Promise<void>;
  submit(req: TxRequest, opts: SubmitOptions): Promise<SubmitResult>; // resolves on BROADCAST
  /** Resolves on `confirmed`; rejects on `reverted`/`failed`. Correlates by
   *  idempotencyKey (NOT hash — a replacement changes the hash). Register it
   *  right after submit: it only observes FUTURE events. */
  waitForConfirmation(idempotencyKey: string): Promise<TxEventRecord>;
  reattach(tx: ReattachInput): void;
  on(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  off(event: TxEvent, cb: (rec: TxEventRecord) => void): void;
  wallets(): WalletState[];
  stats(): PoolStats;
}

interface PoolStats {
  wallets: WalletState[];
  stickyKeys: number; // active sticky bindings — watch for unbounded growth (leak detector)
}
```

### Configuration — `WalletPoolConfig`

```ts
interface WalletPoolConfig {
  ownerId: string;                 // static-partition owner id (this instance owns exactly `signers`)
  chainId: number;
  signers: Signer[];               // the owned account set — one nonce lane each
  chainClient: ChainClient;
  feeOracle: FeeOracle;
  selector?: WalletSelector;       // default: LeastInflightSelector
  confirmations?: number;          // depth before "confirmed". default 1
  confirmTickMs?: number;          // receipt poll cadence. default 4000
  stuckAfterMs?: number;           // unmined this long -> bump + replace. default 30000
  maxAttempts?: number;            // replacement attempts before "failed". default 5
  maxInflightPerAccount?: number;  // queued+unconfirmed cap; submit() throws above it. default 512
  minBalanceWei?: bigint;          // below this -> account unhealthy, dropped from rotation
  onLowBalance?: (w: { address: Address; balanceWei: bigint }) => void;
  funder?: Funder;                 // optional auto-refill (see TreasuryFunder)
  logger?: Logger;
}
```

### Seam 1 — `Signer` (custody)

```ts
interface Signer {
  readonly address: Address;
  /** Sign EXACTLY the given tx. Deterministic, no hidden state. Returns raw bytes. */
  signTransaction(tx: SignableTx): Promise<Hex>;
}
// Bundled: LocalKeySigner (in-process private key; dev / low-value).
```

### Seam 2 — `FeeOracle` (price + bump)

```ts
interface FeeContext {
  chainId: number;
  attempt: number;        // 0 on first send; increments per replacement
  client: ChainClient;
}

interface FeeOracle {
  estimate(ctx: FeeContext): Promise<FeeFields>;
  /** Replacement fees. MUST beat the node's rule (>= ~12.5% over `previous`). */
  bump(previous: FeeFields, ctx: FeeContext): Promise<FeeFields>;
}
// Bundled: LegacyFeeOracle, Eip1559FeeOracle. Default bump: +12.5%.
```

### Seam 3 — `ChainClient` (read RPC + broadcast)

```ts
interface ChainClient {
  getTransactionCount(addr: Address, tag: "pending" | "latest"): Promise<number>;
  estimateGas(tx: SignableTx): Promise<bigint>;
  getBalance(addr: Address): Promise<bigint>;
  getBaseFeePerGas(): Promise<bigint | null>;   // null on legacy chains
  sendRawTransaction(raw: Hex): Promise<Hash>;   // idempotent: re-sending the same raw tx is safe
  getTransactionReceipt(hash: Hash): Promise<Receipt | null>; // null = not yet mined
  getBlockNumber(): Promise<bigint>;
  classifyError(err: unknown): RpcErrorClass;
}
// Bundled: ViemChainClient (over viem/actions). `classifyRpcError` helper exported.
```

### Routing — `Router` / `WalletSelector`

```ts
interface WalletSelector {
  pick(candidates: WalletState[], req: TxRequest): Address; // among healthy candidates
}

interface Router {
  route(candidates: WalletState[], req: TxRequest, opts: SubmitOptions): Address;
  bind(orderingKey: string, account: Address): void;  // re-pin + acquire a ref (reattach)
  release(orderingKey: string): void;                 // release one ref; evict at zero
  size(): number;                                     // sticky bindings (leak observability)
}
// Bundled: DefaultRouter (sticky-by-orderingKey, ref-counted) + LeastInflightSelector.
```

### Optional — `Funder` (auto-refill)

```ts
interface Funder {
  maybeTopUp(addr: Address): Promise<void>;
}

// Bundled: TreasuryFunder — sends native gas from a treasury account to drained
// accounts. Own nonce lane, one top-up per recipient in flight, treasury floor.
interface TreasuryFunderOptions {
  signer: Signer;            // the treasury account (keep separate from pool signers)
  chainClient: ChainClient;
  feeOracle: FeeOracle;
  chainId: number;
  targetBalanceWei: bigint;  // top each drained account up to (at least) this
  minTreasuryWei?: bigint;   // never spend the treasury below this. default 0n
  logger?: Logger;
}
```

### Optional — `PoolStore` / `BalanceMonitor`

```ts
interface PoolStore {
  record(rec: TxEventRecord): Promise<void>;            // write-through on each event
  loadActive(wallets: Address[]): Promise<TxEventRecord[]>; // feeds reattach() on boot
}
// Bundled: InMemoryStore (dev only — unbounded, crash-unsafe).

interface BalanceMonitor {
  start(): void;
  stop(): void;
  isHealthy(addr: Address): boolean;
}
```

---

## Data types

```ts
type Address = `0x${string}`; // 20-byte
type Hex     = `0x${string}`; // arbitrary bytes (calldata / raw tx)
type Hash    = `0x${string}`; // 32-byte

type FeeFields =
  | { type: "legacy";  gasPrice: bigint }
  | { type: "eip1559"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

// What you submit. `data` is calldata -> a contract call; omit it for a plain transfer.
interface TxRequest    { to: Address; data?: Hex; value?: bigint; gasLimit?: bigint }
interface SubmitOptions{ idempotencyKey: string; orderingKey?: string; metadata?: Record<string, unknown> }
interface SubmitResult { account: Address; nonce: number; hash: Hash; fees: FeeFields }

// A fully-specified tx handed to a Signer.
interface SignableTx { chainId: number; nonce: number; to: Address; data?: Hex; value?: bigint; gas: bigint; fees: FeeFields }

// Replayed on boot to resume tracking an in-flight tx.
interface ReattachInput { idempotencyKey: string; account: Address; nonce: number; hash: Hash; fees: FeeFields; orderingKey?: string; metadata?: Record<string, unknown> }

// Emitted on every lifecycle transition; you persist these.
type TxStatus = "broadcast" | "mined" | "confirmed" | "reverted" | "replaced" | "failed";
type TxEvent  = TxStatus;
interface TxEventRecord { idempotencyKey: string; orderingKey?: string; account: Address; nonce: number; hash: Hash; status: TxStatus; fees: FeeFields; attempts: number; metadata?: Record<string, unknown>; error?: string; at: number }

interface WalletState { address: Address; inflightCount: number; nonceCursor: number; balanceWei: bigint; healthy: boolean }
interface Receipt     { status: "success" | "reverted"; blockNumber: bigint; transactionHash: Hash }

type RpcErrorClass = "nonce-drift" | "transient" | "revert" | "fatal";
interface Logger { debug(m: string, x?: unknown): void; info(m: string, x?: unknown): void; warn(m: string, x?: unknown): void; error(m: string, x?: unknown): void }
```

> Data types are defined as zod schemas (exported alongside the inferred types, e.g.
> `txRequestSchema`) so the engine validates at its boundaries. Behavioral interfaces
> (Signer, ChainClient, …) are plain TS — zod validates data, not behavior.

---

## Lifecycle

### Submit (one tx)

```
submit(req, opts)
  │ zod-validate req + opts
  ├─▶ Router.route(wallets, req, opts) → ManagedAccount   (sticky if orderingKey, else least-inflight)
  │     · if the submit then throws (cap / broadcast error), the ordered ref is released → sticky map stays bounded
  ▼
ManagedAccount.submit
  └─▶ NonceLane.withNextNonce(n):                         ◀── mutex serializes this account
        FeeOracle.estimate → ChainClient.estimateGas → Signer.sign → ChainClient.sendRawTransaction
        track inflight[n] = { signable, hash, attempts: 1, replaceable: true }; cursor = n + 1
  ▼
emit "broadcast" → resolves submit()    (resolves on MEMPOOL, not on confirmation)
```

### Supervisor tick (every `confirmTickMs`)

```
each ManagedAccount → confirmTick():
   getTransactionReceipt(hash)
   ├ reverted              → settle "reverted"
   ├ confirmed (depth ≥ N) → settle "confirmed"
   ├ mined (depth < N)     → emit "mined" once
   └ null & stuck (age ≥ stuckAfterMs):
        · !replaceable (reattached placeholder, no calldata) → keep polling, never replace
        · attempts ≥ maxAttempts → settle "failed"
        · else → replace(): FeeOracle.bump → re-sign SAME nonce → emit "replaced"
                 (nonce-drift on send ⇒ original already landed ⇒ keep old hash)

then refreshBalances():
   getBalance(addr) → WalletState.balanceWei
   if < minBalanceWei → mark unhealthy (Router drops it) + onLowBalance(...) + Funder.maybeTopUp(addr)
```

### Events, waiters & durability

```
every transition ─▶ handleEvent(rec)
   ├▶ listeners[status]    → on("broadcast"|"mined"|"confirmed"|"reverted"|"replaced"|"failed")
   ├▶ TERMINAL: Router.release(orderingKey)              (evict sticky binding at refcount 0)
   └▶ TERMINAL: resolve/reject waitForConfirmation(idempotencyKey)

crash recovery: your store ──reattach(rec)──▶ pool       (resumes tracking; reattached entries
                                                          are confirm-only, never auto-replaced)
```

---

## Ownership contract

| walletsforce **guarantees** | **you** own |
|---|---|
| correct, gap-free nonce per account | a durable journal (your own store) |
| single-writer per account (static partition) | idempotency / dedupe on your business unit |
| no in-process duplicate sends | exactly-once effect across a crash |
| receipt tracking + stuck-tx replacement | replaying unconfirmed txs after restart (`reattach`) |

walletsforce holds state **in memory only**. Durability is wired through events-out
(`on(...)`) and reattach-in (`reattach(...)`) onto *your* store.

---

## Packaging notes

- **ESM-only** (`"type": "module"`).
- **`viem` is a `peerDependency`** — the consumer owns a single viem copy (shared types
  and runtime). `zod` is an internal `dependency` (the public API uses plain objects,
  not zod instances).
- Built with `tsup` → `dist/index.js` + `dist/index.d.ts`; `viem`/`zod` are external.
