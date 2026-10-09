import { describe, expect, it } from "vitest";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { normaliseOracle, priceFromAccounts, isReceiptOracle } from "./oracle";
import { PERENA, PERENA_SHARES, perenaOracleConfig } from "./perena";
import { MarginIndexModel } from "./margin";

describe("vault receipt valuation", () => {
  it.each(Object.values(PERENA_SHARES))(
    "reads the registered NAV and rejects stale or foreign state",
    (share) => {
      const oracle = normaliseOracle(perenaOracleConfig(share));
      const data = Buffer.alloc(share.priceAt + 16);
      data.writeBigUInt64LE(1_101_795n, share.priceAt);
      data.writeBigInt64LE(10_000n, share.priceAt + 8);
      const info: AccountInfo<Buffer> = {
        data,
        owner: PERENA,
        executable: false,
        lamports: 1,
        rentEpoch: 0,
      };
      const accounts = new Map([[share.account.toBase58(), info]]);
      expect(isReceiptOracle(oracle)).toBe(false); // Perena must not use Kamino's exchange-rate decoder.
      expect(priceFromAccounts(oracle, accounts, 10_001n)).toMatchObject({
        usd: 1.101795,
        fresh: true,
        source: "receipt",
      });
      expect(priceFromAccounts(oracle, accounts, 13_601n)?.fresh).toBe(false);
      expect(priceFromAccounts(oracle, accounts, 6_399n)?.fresh).toBe(false);
      accounts.set(share.account.toBase58(), {
        ...info,
        owner: PublicKey.default,
      });
      expect(priceFromAccounts(oracle, accounts, 10_001n)).toBeNull();
    },
  );
});
describe("global allowed token scans", () => {
  it("retains global scan order when a receipt balance is fully withdrawn", () => {
    const model = new MarginIndexModel(null, undefined, [2, 7, 9]);
    model.deposit(7, 100n);
    model.withdraw(7, 100n);
    expect(model.collateral.slice(0, 3)).toEqual([2, 7, 9]);
    expect(model.vault.get(7)).toBe(0n);
  });
  it("includes allowed tokens before a create and borrow batch", () => {
    const model = new MarginIndexModel(null, undefined, [2, 7, 9]);
    model.borrow(2, 50n, true);
    expect(model.collateral.filter((i) => i !== 65535)).toEqual([2, 7, 9]);
    expect(model.debt.filter((i) => i !== 65535)).toEqual([2]);
  });
});
