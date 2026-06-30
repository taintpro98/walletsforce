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
npm run basic      # offline, zero setup
npm run testnet    # real on-chain send (needs env vars)
npm run typecheck  # tsc --noEmit over the examples
```

Examples run directly from TypeScript via [`tsx`](https://github.com/privatenumber/tsx) — no build step.

## `basic.ts` — offline, zero setup

Submits a tx and waits for confirmation against an inline fake `ChainClient`
(typed as the real `ChainClient` interface). No RPC, no funds, no real keys.

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
