import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";

const reads = vi.hoisted(() => ({ margin: vi.fn(), lender: vi.fn(), wallet: vi.fn() }));
vi.mock("@/lib/solana/margin", () => ({ fetchMarginSnapshot: reads.margin, serializeMarginSnapshot: (value: unknown) => value }));
vi.mock("@/lib/solana/lend", () => ({ fetchLenderPositions: reads.lender }));
vi.mock("@/lib/solana/balances", () => ({ fetchWalletBalances: reads.wallet }));

const owner = PublicKey.default.toBase58();
let get: typeof import("./route").GET;
const request = (fresh = false) => get(new NextRequest(`http://localhost/api/account/${owner}${fresh ? "?fresh=1" : ""}`), { params: Promise.resolve({ addr: owner }) });

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  reads.margin.mockResolvedValue({ owner, balance: "1" });
  reads.lender.mockResolvedValue({});
  reads.wallet.mockResolvedValue({ ui: { SOL: "1" }, wsolRaw: 0n });
  ({ GET: get } = await import("./route"));
});

it("coalesces concurrent normal requests and reuses the settled snapshot", async () => {
  const responses = await Promise.all([request(), request()]);
  expect(responses.every((response) => response.status === 200)).toBe(true);
  await request();
  expect(reads.margin).toHaveBeenCalledTimes(1);
  expect(reads.lender).toHaveBeenCalledTimes(1);
  expect(reads.wallet).toHaveBeenCalledTimes(1);
  expect(reads.margin.mock.calls[0][1]).toEqual({ publicState: "cached" });
});

it("bypasses the cache with one new scope shared through all fresh branches", async () => {
  await request();
  await request(true);
  const scope = reads.margin.mock.calls[1][1];
  expect(scope).toBeTypeOf("object");
  expect(scope.publicState).toBe("fresh");
  expect(reads.lender.mock.calls[1][1]).toBe(scope);
  expect(reads.wallet.mock.calls[1][2]).toBe(scope);
  await request(true);
  expect(reads.margin.mock.calls[2][1]).not.toBe(scope);
});

it("does not retain failed snapshots", async () => {
  reads.margin.mockRejectedValueOnce(new Error("RPC unavailable"));
  expect((await request()).status).toBe(502);
  expect((await request()).status).toBe(200);
  expect(reads.margin).toHaveBeenCalledTimes(2);
});

it("rejects malformed owners before spending RPC calls", async () => {
  const result = await get(new NextRequest("http://localhost/api/account/invalid"), { params: Promise.resolve({ addr: "invalid" }) });
  expect(result.status).toBe(400);
  expect(reads.margin).not.toHaveBeenCalled();
});
