import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, PublicKey } from "@solana/web3.js";
import type { ReadScope } from "../async";

const rpc = vi.hoisted(() => ({ accounts: vi.fn(), clock: vi.fn(), connection: {} }));
vi.mock("./connection", () => ({
  getConnection: () => rpc.connection,
  getMultipleAccountsChunked: rpc.accounts,
  forkUnixTimestamp: rpc.clock,
}));
vi.mock("./vault-oracles", () => ({ basisOracleAccounts: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  rpc.accounts.mockImplementation(async (_connection, keys: PublicKey[]) => keys.map(() => null));
  rpc.clock.mockResolvedValue(100n);
});
afterEach(() => vi.useRealTimers());

describe.each(["pools", "assets"] as const)("%s public display reads", (kind) => {
  async function reader() {
    const state = await import("./protocol-state");
    const read = kind === "pools" ? state.fetchPoolStates : state.fetchAllAssetConfigs;
    return (scope?: ReadScope, connection = rpc.connection as Connection) => read(connection, scope);
  }

  it("shares pending display work across requests and expires settled results", async () => {
    const read = await reader();
    const [a, b] = await Promise.all([read({ publicState: "cached" }), read({ publicState: "cached" })]);
    expect(b).toBe(a);
    expect(await read({ publicState: "cached" })).toBe(a);
    expect(rpc.accounts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await read({ publicState: "cached" })).not.toBe(a);
    expect(rpc.accounts).toHaveBeenCalledTimes(2);
  });

  it("never supplies cached display state to execution reads", async () => {
    const read = await reader();
    const display = await read({ publicState: "cached" });
    expect(await read()).not.toBe(display);
    await read();
    await read({});
    expect(rpc.accounts).toHaveBeenCalledTimes(4);
  });

  it("isolates connections and retries failed display reads", async () => {
    const read = await reader();
    rpc.accounts.mockRejectedValueOnce(new Error("offline"));
    await expect(read({ publicState: "cached" })).rejects.toThrow("offline");
    const recovered = await read({ publicState: "cached" });
    expect(await read({ publicState: "cached" }, {} as Connection)).not.toBe(recovered);
    expect(rpc.accounts).toHaveBeenCalledTimes(3);
  });

  it("fresh scopes bypass pending old reads without letting old completion replace new state", async () => {
    const read = await reader();
    let finish!: (value: null[]) => void;
    rpc.accounts.mockImplementationOnce((_connection, keys: PublicKey[]) => new Promise<null[]>((resolve) => {
      finish = () => resolve(keys.map(() => null));
    }));
    const old = read({ publicState: "cached" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const scope: ReadScope = { publicState: "fresh" };
    const fresh = read(scope);
    expect(read(scope)).toBe(fresh);
    const current = await fresh;
    finish([]);
    expect(await old).not.toBe(current);
    expect(await read({ publicState: "cached" })).toBe(current);
    expect(rpc.accounts).toHaveBeenCalledTimes(2);
  });
});
