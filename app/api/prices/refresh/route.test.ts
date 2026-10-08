import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prices: vi.fn(), heal: vi.fn() }));
vi.mock("@/lib/solana/server/fork-prices", () => ({ refreshForkPrices: mocks.prices }));
vi.mock("@/lib/solana/server/kamino-heal", () => ({ healKaminoReserves: mocks.heal }));
let POST: typeof import("./route").POST;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.prices.mockResolvedValue([]); mocks.heal.mockResolvedValue([]);
  ({ POST } = await import("./route"));
});
it("coalesces a burst of refreshes and throttles subsequent mounts", async () => {
  const results = await Promise.all([POST(), POST(), POST()]);
  expect(results.every((r) => r.status === 200)).toBe(true);
  expect((await POST()).status).toBe(200);
  expect(mocks.prices).toHaveBeenCalledTimes(1); expect(mocks.heal).toHaveBeenCalledTimes(1);
});
it("does not cache a failed refresh", async () => {
  mocks.prices.mockRejectedValueOnce(new Error("RPC unavailable"));
  expect((await POST()).status).toBe(502);
  expect((await POST()).status).toBe(200);
  expect(mocks.prices).toHaveBeenCalledTimes(2);
});
it("does not release the refresh lock while another write branch is still running", async () => {
  let finish!: () => void;
  mocks.prices.mockRejectedValueOnce(new Error("failed"));
  mocks.heal.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  const first = POST(); await Promise.resolve();
  const second = POST(); await Promise.resolve();
  expect(mocks.prices).toHaveBeenCalledTimes(1);
  finish(); expect((await first).status).toBe(502); expect((await second).status).toBe(502);
});
