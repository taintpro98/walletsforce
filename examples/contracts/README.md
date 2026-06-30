# Demo contracts (Hardhat)

A small Hardhat project with two contracts for walletsforce to submit calls against:

- **`Counter`** — trivial state change (`increment()`, `incrementBy(n)`); a clean
  target for non-payable contract calls.
- **`DemoToken`** — minimal ERC-20 (OpenZeppelin); `transfer(address,uint256)` is
  exactly what the `contract-call` example encodes.

## Run locally (without Docker)

```bash
npm install
npx hardhat compile

# terminal 1: a local chain
npm run node            # hardhat node on :8545 (chainId 31337)

# terminal 2: deploy to it
npm run deploy:local    # writes deployments/local.json
```

`deploy:local` targets the `local` network, configured from env vars (defaults
shown):

| Env var | Default |
|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` |
| `PRIVATE_KEY` | dev account #0 `0xac09…ff80` (PUBLIC test key) |

## Run via Docker

See [`../docker-compose.local.yml`](../docker-compose.local.yml) — it builds this
project into one image, runs a chain, and deploys to it in one command.

## Output

`deployments/local.json` (git-ignored) is the contract of the local stack — it
holds each contract's **address and ABI**, so consumers load everything from one
place (no hardcoding). The walletsforce `../local.ts` example reads exactly this:

```json
{
  "chainId": 31337,
  "deployer": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "contracts": {
    "Counter":   { "address": "0x…", "abi": [ /* … */ ] },
    "DemoToken": { "address": "0x…", "abi": [ /* … */ ] }
  }
}
```

Via Docker, the `deploy` service publishes this file to `examples/deployments/`
through a volume mount, where the walletsforce `local.ts` example consumes it.
(A standalone `npm run deploy:local` writes to this project's own
`deployments/local.json` instead.)
