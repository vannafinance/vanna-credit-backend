import { beforeEach, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const rpc = vi.hoisted(() => ({ getSignaturesForAddress: vi.fn(), getParsedTransaction: vi.fn() }));
vi.mock("@/lib/solana/connection", () => ({ getConnection: () => rpc }));
vi.mock("@/lib/solana/tokens", () => ({ getToken: () => ({ mint: { toBase58: () => "usdc" } }) }));
vi.mock("./catalog.server", () => ({ getMarketInfo: vi.fn(), marketIdForMint: vi.fn() }));
vi.mock("./events.server", () => ({ eventIdForMarket: vi.fn() }));
vi.mock("./pool.server", () => ({ poolPda: vi.fn() }));

const owner = Keypair.generate().publicKey;
let history: typeof import("./activity.server").getTradeHistory;
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  ({ getTradeHistory: history } = await import("./activity.server"));
  rpc.getSignaturesForAddress.mockResolvedValue([]);
});

it("shares concurrent scans but reads again after settlement", async () => {
  await Promise.all([history(owner), history(owner)]);
  expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  await history(owner);
  expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(2);
});

it("does not combine different wallets or history limits", async () => {
  await Promise.all([history(owner, 1), history(owner, 2), history(Keypair.generate().publicKey, 1)]);
  expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(3);
});

it("fresh scopes do not join scans started before confirmation", async () => {
  let release!: (value: []) => void;
  rpc.getSignaturesForAddress.mockImplementationOnce(() => new Promise<[]>((resolve) => { release = resolve; }));
  const old = history(owner);
  await Promise.resolve();
  expect(await history(owner, 40, {})).toEqual([]);
  expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(2);
  release([]);
  await old;
});

it("does not cache missing transaction bodies", async () => {
  rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "missing", err: null }]);
  rpc.getParsedTransaction.mockResolvedValue(null);
  await history(owner);
  await history(owner);
  expect(rpc.getParsedTransaction).toHaveBeenCalledTimes(2);
});
