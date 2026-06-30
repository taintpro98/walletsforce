# Examples

A **standalone TypeScript project** that consumes the published `walletsforce`
package from npm — exactly as a real user would. It has its own `package.json`,
`tsconfig.json`, and `node_modules`, independent of the library repo.

## Setup

```bash
cd examples
npm install
```

This installs `walletsforce` from the npm registry (see the version in
`package.json`). To test against **local, unpublished** changes instead, run
`npm link` in the repo root and `npm link walletsforce` here.

## Run

```bash
npm run basic          # offline, zero setup
npm run contract-call  # offline: encode + submit an ERC-20 contract call
npm run local          # local chain: 10-signer pool fans calls across lanes
npm run funder         # local chain: TreasuryFunder auto-refills a drained signer
npm run testnet        # real on-chain send (needs env vars)
npm run typecheck      # tsc --noEmit over the examples
```

> `funder.ts` needs **walletsforce ≥ 0.1.0** (`TreasuryFunder`). Until 0.1.0 is
> published, link the local build (`npm link` in the repo root, then
> `npm link walletsforce` here).

Examples run directly from TypeScript via [`tsx`](https://github.com/privatenumber/tsx) — no build step.

## `basic.ts` — offline, zero setup

Submits a tx and waits for confirmation against an inline fake `ChainClient`
(typed as the real `ChainClient` interface). No RPC, no funds, no real keys.

## `contract-call.ts` — offline, encode + submit a contract call

Shows that walletsforce is ABI-agnostic: you encode calldata yourself (viem's
`encodeFunctionData`) and pass it as the tx `data`; `to` is the contract address.
Encodes an ERC-20 `transfer(address,uint256)` and submits it against an inline
fake `ChainClient`. No RPC, no funds.

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
