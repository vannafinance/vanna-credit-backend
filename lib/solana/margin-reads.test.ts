import { beforeEach, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { emptyOracleConfig, type OraclePrice } from "./oracle";
import { getToken } from "./tokens";
import { VAULTS } from "./vault-catalogue";
import { PHOENIX_EXCHANGE } from "./phoenix";
import type { AssetConfigState } from "./protocol-state";

const reads = vi.hoisted(() => ({ raw: vi.fn(), assets: vi.fn(), pools: vi.fn(), accounts: vi.fn(), basis: vi.fn(), venue: vi.fn(), price: vi.fn(), connection: {} }));
vi.mock("./connection", () => ({ getConnection: () => reads.connection, forkUnixTimestamp: async () => 100n, getMultipleAccountsChunked: reads.accounts }));
vi.mock("./program", async (original) => ({
  ...await original<typeof import("./program")>(),
  accounts: () => ({ marginAccount: { fetchNullable: reads.raw }, protocolConfig: { fetch: async () => ({ allowedTokens: [0, 1] }) } }),
}));
vi.mock("./protocol-state", async (original) => ({
  ...await original<typeof import("./protocol-state")>(),
  fetchAllAssetConfigs: reads.assets,
  fetchPoolStates: reads.pools,
  tokenAccountAmount: (info: unknown) => info ? 1_000_000n : 0n,
}));
vi.mock("./vault-oracles", () => ({ basisOraclePrice: reads.basis }));
vi.mock("./phoenix-state", () => ({ loadPhoenixVenue: reads.venue, venueOracleAccounts: vi.fn() }));
vi.mock("./oracle", async (original) => ({ ...await original<typeof import("./oracle")>(), priceFromAccounts: reads.price }));

const owner = PublicKey.default;
const basis = VAULTS.find(v => v.kind === "basis")!;
const oracleKey = getToken("USDC").mint;
const price: OraclePrice = { price: 1n, exponent: 0, usd: 1, conf: 0n, publishTime: 100n, source: "scope", fresh: true };
function asset(index: number, mint: PublicKey, kind: "token" | "venue" = "token"): AssetConfigState {
  return {
    address: mint, mint, tokenProgram: TOKEN_PROGRAM_ID, reserve: PublicKey.default, kind,
    oracleProgram: PublicKey.default, oracle: emptyOracleConfig(), oracleAccounts: [oracleKey],
    maxCollateralPerMargin: 0n, maxPriceAgeSecs: 60, maxConfidenceBps: 100,
    liquidationBonusBps: 0, assetIndex: index, decimals: 6, collateralEnabled: true,
    borrowEnabled: false, priceSource: "oracle", priceSourceAccount: PublicKey.default,
  };
}
const assets = new Map([
  [0, asset(0, getToken("USDC").mint)],
  [1, asset(1, new PublicKey(basis.mint))],
  [2, asset(2, PHOENIX_EXCHANGE, "venue")],
]);
const holdings = () => [{}, null, null, {}, null, null];
let snapshot: typeof import("./margin").fetchMarginSnapshot;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  reads.raw.mockResolvedValue({ authority: owner, status: 0, venueCount: 1, debtCount: 0, venueAssetIndexes: [2], debtAssetIndexes: [], eventSequence: 1n });
  reads.assets.mockResolvedValue(assets);
  reads.pools.mockResolvedValue({});
  reads.accounts.mockImplementation(async (_connection, keys: PublicKey[]) => keys.some(k => k.equals(oracleKey)) ? [null] : holdings());
  reads.price.mockReturnValue(price);
  reads.basis.mockResolvedValue({ ...price, price: 2n, usd: 2 });
  reads.venue.mockResolvedValue({ valueNano: 3_000_000_000n });
  ({ fetchMarginSnapshot: snapshot } = await import("./margin"));
});

it("starts held Basis valuation and Phoenix reads while unrelated token oracles are pending", async () => {
  let finishOracles!: () => void;
  reads.accounts.mockImplementation(async (_connection, keys: PublicKey[]) => {
    if (keys.some(k => k.equals(oracleKey))) return new Promise<null[]>((resolve) => { finishOracles = () => resolve([null]); });
    return holdings();
  });
  const scope = { publicState: "fresh" as const };
  const result = snapshot(owner, scope);
  await vi.waitFor(() => expect(reads.basis).toHaveBeenCalledTimes(1));
  expect(reads.venue).toHaveBeenCalledTimes(1);
  expect(reads.basis).toHaveBeenCalledWith(basis, reads.connection, scope);
  finishOracles();
  const value = await result;
  expect(value.totalCollateralNano).toBe(6_000_000_000n);
  expect(value.totalDebtNano).toBe(0n);
  expect(value.healthFactor).toBeNull();
});

it("does not simulate unheld Basis assets or load a venue for a missing margin account", async () => {
  reads.raw.mockResolvedValue(null);
  const value = await snapshot(owner);
  expect(value.exists).toBe(false);
  expect(value.totalCollateralNano).toBe(0n);
  expect(reads.basis).not.toHaveBeenCalled();
  expect(reads.venue).not.toHaveBeenCalled();
});

it("preserves the last good Basis value and marks it stale when simulation fails", async () => {
  const before = await snapshot(owner);
  reads.basis.mockRejectedValueOnce(new Error("simulation unavailable"));
  const after = await snapshot(owner);
  expect(after.totalCollateralNano).toBe(before.totalCollateralNano);
  expect(after.stalePrices).toContain(basis.symbol);
});

it("rejects failed venue valuation rather than returning partial collateral", async () => {
  reads.venue.mockRejectedValueOnce(new Error("venue unavailable"));
  await expect(snapshot(owner)).rejects.toThrow("venue unavailable");
});
