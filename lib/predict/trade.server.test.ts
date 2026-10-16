import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MARKET_ACCOUNT_SIZE, MARKET_OFFSETS, WORLD_PROGRAM_ID } from "./constants";
import type { MarketInfo } from "./types";

const reads = vi.hoisted(() => ({ account: vi.fn(), balances: vi.fn(), info: vi.fn(), maker: vi.fn(), pools: vi.fn(), shares: vi.fn(), table: vi.fn(), quotes: vi.fn() }));
vi.mock("@/lib/solana/connection", () => ({ getConnection: () => ({ getAccountInfo: reads.account, getMultipleAccountsInfo: reads.balances }) }));
vi.mock("./catalog.server", () => ({ getMarketInfo: reads.info }));
vi.mock("./maker.server", () => ({ ensureMakerReady: reads.maker }));
vi.mock("./lut.server", () => ({ getPredictLookupTable: reads.table }));
vi.mock("./pool.server", () => ({ readPoolStates: reads.pools, readShareBalances: reads.shares, createPoolIx: vi.fn(), depositIxs: vi.fn(), redeemIxs: vi.fn() }));
vi.mock("./jupiter.server", () => ({ healRouteAccounts: vi.fn(), manifestQuote: vi.fn(), swapInstructions: vi.fn() }));
vi.mock("./prices.server", () => ({ refreshQuotes: reads.quotes, getMarketPrices: () => ({ yesAsk: 0.5 }) }));
import { buildTrade } from "./trade.server";

const keys = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const info: MarketInfo = { id: keys[0].toBase58(), yesMint: keys[1].toBase58(), noMint: keys[2].toBase58(), vault: keys[3].toBase58(), resolutionKind: 0, startMs: null, endMs: null, name: "Test", symbol: "TEST", question: "Test?", description: null, image: null, category: "other", league: null, groupId: null };
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.resetAllMocks();
  const data = Buffer.alloc(MARKET_ACCOUNT_SIZE);
  keys[1].toBuffer().copy(data, MARKET_OFFSETS.yesMint);
  keys[2].toBuffer().copy(data, MARKET_OFFSETS.noMint);
  keys[3].toBuffer().copy(data, MARKET_OFFSETS.vault);
  reads.info.mockResolvedValue(info);
  reads.account.mockImplementation(async (key: PublicKey) => key.equals(keys[0]) ? { owner: new PublicKey(WORLD_PROGRAM_ID), data } : null);
  reads.balances.mockImplementation(async (accounts: PublicKey[]) => accounts.length === 2 && accounts[0].equals(keys[0]) ? [{ owner: new PublicKey(WORLD_PROGRAM_ID), data }, null] : [null, null, null]);
  reads.pools.mockResolvedValue(new Map([[info.id, { exists: false }]]));
  reads.shares.mockResolvedValue(new Map());
  reads.table.mockResolvedValue(null);
  reads.quotes.mockResolvedValue(undefined);
});

it("starts wallet balances while maker readiness is pending and still validates funds", async () => {
  vi.useFakeTimers();
  let release!: (maker: ReturnType<typeof Keypair.generate>) => void;
  const started = new Promise<void>((resolve) => {
    reads.maker.mockImplementation(() => new Promise((done) => { release = done; resolve(); }));
  });
  const build = buildTrade({ owner: keys[0].toBase58(), legs: [{ marketId: info.id, outcome: "yes", side: "buy", amount: 10 }], pay: "CASH", noPool: true });
  const result = expect(build).rejects.toThrow("Not enough CASH");
  await started;
  expect(reads.balances).toHaveBeenCalledTimes(2);
  expect(reads.balances.mock.calls[0][0].map((key: PublicKey) => key.toBase58())).toEqual([info.id, info.vault]);
  expect(reads.quotes).toHaveBeenCalledTimes(1);
  release(Keypair.generate());
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects invalid fork market ownership before starting maker work", async () => {
  reads.balances.mockResolvedValue([null, null]);
  await expect(buildTrade({ owner: keys[0].toBase58(), legs: [{ marketId: info.id, outcome: "yes", side: "buy", amount: 10 }], pay: "CASH", noPool: true })).rejects.toThrow("not available on the fork");
  expect(reads.maker).not.toHaveBeenCalled();
});

it("reads the actual vault when the fork and catalog vault pointers differ", async () => {
  const actualVault = Keypair.generate().publicKey;
  const data = Buffer.alloc(MARKET_ACCOUNT_SIZE);
  keys[1].toBuffer().copy(data, MARKET_OFFSETS.yesMint);
  keys[2].toBuffer().copy(data, MARKET_OFFSETS.noMint);
  actualVault.toBuffer().copy(data, MARKET_OFFSETS.vault);
  const vault = Buffer.alloc(64);
  keys[0].toBuffer().copy(vault, 32);
  reads.balances.mockReset()
    .mockResolvedValueOnce([{ owner: new PublicKey(WORLD_PROGRAM_ID), data }, null])
    .mockResolvedValueOnce([{ data: vault }])
    .mockResolvedValueOnce([null, null, null]);
  reads.maker.mockResolvedValue(Keypair.generate());
  await expect(buildTrade({ owner: keys[0].toBase58(), legs: [{ marketId: info.id, outcome: "yes", side: "buy", amount: 10 }], pay: "CASH", noPool: true })).rejects.toThrow("Not enough CASH");
  expect(reads.balances.mock.calls[1][0].map((key: PublicKey) => key.toBase58())).toEqual([actualVault.toBase58()]);
  expect(reads.balances).toHaveBeenCalledTimes(3);
});
