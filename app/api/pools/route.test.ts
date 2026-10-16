import { beforeEach, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => vi.fn());
vi.mock("@/lib/solana/protocol-state", () => ({ fetchPoolStates: pools, serializePoolState: (p: unknown) => p }));
import { GET } from "./route";

beforeEach(() => { pools.mockReset(); pools.mockResolvedValue({ SOL: { supplyApr: 0.01 } }); });

it("opts normal pool statistics into the public display cache", async () => {
  const result = await GET(new Request("http://localhost/api/pools"));
  expect(result.status).toBe(200);
  expect(pools).toHaveBeenCalledWith(undefined, { publicState: "cached" });
  expect(await result.json()).toEqual({ pools: { SOL: { supplyApr: 0.01 } } });
});

it("bypasses old pool state after a transaction", async () => {
  expect((await GET(new Request("http://localhost/api/pools?fresh=1"))).status).toBe(200);
  expect(pools).toHaveBeenCalledWith(undefined, { publicState: "fresh" });
});

it("returns a failure instead of fabricated pool statistics", async () => {
  pools.mockRejectedValueOnce(new Error("RPC unavailable"));
  expect((await GET(new Request("http://localhost/api/pools"))).status).toBe(502);
});
