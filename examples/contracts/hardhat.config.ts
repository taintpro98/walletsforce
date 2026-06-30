import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// Where to deploy, and with which key. Defaults match a local Hardhat/Anvil node
// and its well-known dev account #0 (a PUBLIC test key — never use real funds).
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const PRIVATE_KEY =
  process.env.PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const config: HardhatUserConfig = {
  solidity: "0.8.24",
  networks: {
    local: {
      url: RPC_URL,
      accounts: [PRIVATE_KEY],
    },
  },
};

export default config;
