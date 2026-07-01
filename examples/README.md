# Examples

A **standalone TypeScript project** with its own `package.json`, `tsconfig.json`,
and `node_modules`. It's linked to the **local build** of the library
(`"walletsforce": "file:.."` in `package.json`), so the examples always reflect
your working tree — no publish step needed.

## Setup

```bash
# from the repo root: build the library the examples resolve to
npm run build

cd examples
npm install            # creates the file:.. symlink to the repo root
```

The examples resolve `walletsforce` → the repo root's `dist/`. After changing
library `src/`, re-run `npm run build` at the root and the examples pick it up
automatically (no re-copy, no re-link).

> **viem must stay aligned.** The root and `examples/` each install their own
> `viem` under `^2.21.0`. If a reinstall gives them different 2.x versions,
> `ViemChainClient(publicClient)` will hit a duplicate-viem type clash — reinstall
> both to the same version. (This is the tradeoff of a `file:..` link vs. an npm
> workspace.)

## Run

```bash
npm run basic          # offline, zero setup: submit → supervisor confirms
npm run contract-call  # offline: encode + submit an ERC-20 contract call
npm run durable        # offline: SQLite store survives a "crash" → restore() recovers it
npm run local          # local chain: 10-signer pool fans calls across lanes
npm run funder         # local chain: TreasuryFunder auto-refills a drained signer
npm run testnet        # real on-chain send (needs env vars)
npm run profile        # measure the library's own CPU / RAM overhead
npm run typecheck      # tsc --noEmit over the examples
```

Each demo builds a `config`, a `substrate` (`createSubstrate`), a `WalletForcePool`,
and a `Supervisor`, then `await pool.start()` + `supervisor.start()` — the standard
single-pod wiring.

Examples run directly from TypeScript via [`tsx`](https://github.com/privatenumber/tsx) — no build step.

## `basic.ts` — offline, zero setup

Submits a tx and waits for confirmation against an inline fake `ChainClient`
(typed as the real `ChainClient` interface). No RPC, no funds, no real keys.

## `contract-call.ts` — offline, encode + submit a contract call

Shows that walletsforce is ABI-agnostic: you encode calldata yourself (viem's
`encodeFunctionData`) and pass it as the tx `data`; `to` is the contract address.
Encodes an ERC-20 `transfer(address,uint256)` and submits it against an inline
fake `ChainClient`. No RPC, no funds.

## `durable.ts` — SQLite crash recovery (offline)

Selects the SQLite store (`createSubstrate(config, { store: { kind: "sqlite", path } })`),
submits a tx (write-ahead-persisted before broadcast), throws away the pool **without
confirming** (a simulated crash), then builds a fresh pool over the **same file** and
`await pool.start()` — `restore()` re-tracks the in-flight tx and the supervisor
confirms it. No RPC. Needs Node ≥ 22.5 (`node:sqlite`).

## `funder.ts` — auto-refill a drained account (local chain)

Creates a pool whose signer starts with **zero balance**, then a `TreasuryFunder`
(funded from local dev account #0) tops it up automatically once the supervisor
sees it below `minBalanceWei`. Prints the signer's balance before/after and its
health flag flipping back to healthy. Needs a local chain on `:8545`.

```bash
docker compose -f docker-compose.local.yml up -d chain
npm run funder
```

## `testnet.ts` — real on-chain send

Sends a real 0-value tx on a testnet using `ViemChainClient`. Needs a testnet
RPC and a key funded with testnet gas (from a faucet). **Never use a key that
controls real funds.**

```bash
RPC_URL="https://sepolia.base.org" \
PRIVATE_KEY="0x..." \
TO="0x...recipient..." \
CHAIN_ID=84532 \
npm run testnet
```

| Env var | Required | Default |
|---|---|---|
| `RPC_URL` | yes | — |
| `PRIVATE_KEY` | yes | — |
| `TO` | no | the signer's own address |
| `CHAIN_ID` | no | `84532` (Base Sepolia) |

## `contracts/` — a local chain + demo contracts (Hardhat + Docker)

A self-contained Hardhat project ([`contracts/`](./contracts)) with a `Counter`
and an ERC-20 `DemoToken`, plus a Docker stack that runs a local chain **and
deploys the contracts** in one command:

```bash
docker compose -f docker-compose.local.yml up --build
```

This brings up a chain on `http://localhost:8545` (chainId 31337) and publishes
the deployed **addresses + ABIs** to `deployments/local.json` (here in `examples/`).

Then run the local demo — it loads everything from that file and submits real
contract calls through walletsforce (it does not deploy anything itself):

```bash
npm run local
```

## `local.ts` — submit contract calls against the local stack

Reads `deployments/local.json` (published by docker compose above), then calls
`Counter.increment()` and `DemoToken.transfer()` through walletsforce, reading
state before/after to prove the calls landed.
