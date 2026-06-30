import { ethers, artifacts, network } from "hardhat";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// Deploys the demo contracts and writes a single artifact — addresses AND ABIs —
// to deployments/local.json. This is the contract of the local stack: consumers
// (e.g. the walletsforce `local.ts` example) load everything they need from here,
// so nothing has to be hardcoded.
async function deployOne(name: string) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const { abi } = await artifacts.readArtifact(name);
  console.log(`${name.padEnd(10)} -> ${address}`);
  return { address, abi };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`network: ${network.name} (chainId ${net.chainId})`);
  console.log(`deployer: ${deployer.address}`);

  const out = {
    chainId: Number(net.chainId),
    deployer: deployer.address,
    contracts: {
      Counter: await deployOne("Counter"),
      DemoToken: await deployOne("DemoToken"),
    },
  };

  const dir = join(__dirname, "..", "deployments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "local.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("wrote deployments/local.json (addresses + ABIs)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
