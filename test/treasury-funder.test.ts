import { describe, it, expect } from "vitest";
import { TreasuryFunder } from "../src/balance";
import { LegacyFeeOracle } from "../src/fee";
import { FakeChainClient, FakeSigner, ADDR_A, ADDR_B } from "./helpers";
import type { Address } from "../src/types";

const TREASURY = "0x00000000000000000000000000000000000000Ee" as Address;
const TARGET = 1_000n;

function setup(over: Partial<ConstructorParameters<typeof TreasuryFunder>[0]> = {}) {
  const client = new FakeChainClient();
  const balances = new Map<string, bigint>();
  // per-address balances (the shared FakeChainClient only has one)
  client.getBalance = async (addr: Address) => balances.get(addr.toLowerCase()) ?? 0n;
  const treasury = new FakeSigner(TREASURY);
  balances.set(TREASURY.toLowerCase(), 10n ** 18n); // well-funded treasury by default

  const funder = new TreasuryFunder({
    signer: treasury,
    chainClient: client,
    feeOracle: new LegacyFeeOracle({ minGasPriceWei: 1_000_000_000n }),
    chainId: 1,
    targetBalanceWei: TARGET,
    minTreasuryWei: 0n,
    ...over,
  });
  return { client, balances, treasury, funder };
}

describe("TreasuryFunder", () => {
  it("tops a drained account up to the target", async () => {
    const { funder, treasury, balances } = setup();
    balances.set(ADDR_A.toLowerCase(), 100n); // below target
    await funder.maybeTopUp(ADDR_A);
    expect(treasury.signed).toHaveLength(1);
    const tx = treasury.signed[0];
    expect(tx.to).toBe(ADDR_A);
    expect(tx.value).toBe(TARGET - 100n); // 900
    expect(tx.gas).toBe(21_000n);
  });

  it("does nothing when the account already meets the target", async () => {
    const { funder, treasury, balances } = setup();
    balances.set(ADDR_A.toLowerCase(), TARGET);
    await funder.maybeTopUp(ADDR_A);
    expect(treasury.signed).toHaveLength(0);
  });

  it("refuses to spend the treasury below its floor", async () => {
    const { funder, treasury, balances } = setup();
    balances.set(ADDR_A.toLowerCase(), 0n);
    balances.set(TREASURY.toLowerCase(), 500n); // can't cover amount(1000)+gas
    await funder.maybeTopUp(ADDR_A);
    expect(treasury.signed).toHaveLength(0);
  });

  it("sends only one top-up per recipient while it's in flight", async () => {
    const { funder, treasury, balances } = setup();
    balances.set(ADDR_A.toLowerCase(), 100n);
    await funder.maybeTopUp(ADDR_A); // sends
    await funder.maybeTopUp(ADDR_A); // still low + pending -> no second send
    expect(treasury.signed).toHaveLength(1);

    // once the balance recovers, the pending marker clears
    balances.set(ADDR_A.toLowerCase(), TARGET);
    await funder.maybeTopUp(ADDR_A);
    expect(treasury.signed).toHaveLength(1);
  });

  it("serializes treasury sends on a single nonce lane", async () => {
    const { funder, treasury, balances } = setup();
    balances.set(ADDR_A.toLowerCase(), 0n);
    balances.set(ADDR_B.toLowerCase(), 0n);
    await funder.maybeTopUp(ADDR_A);
    await funder.maybeTopUp(ADDR_B);
    expect(treasury.signed.map((t) => t.nonce)).toEqual([0, 1]);
  });
});
