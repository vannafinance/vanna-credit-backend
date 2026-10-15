import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
const rpc = vi.hoisted(() => ({ getSignaturesForAddress: vi.fn(), getTransaction: vi.fn() }));
vi.mock("./connection", async (original) => ({ ...await original<typeof import("./connection")>(), getConnection: () => rpc }));
const wallet = PublicKey.default;
let fetchEarnHistory: typeof import("./history").fetchEarnHistory;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  ({ fetchEarnHistory } = await import("./history"));
});
afterEach(() => vi.useRealTimers());

describe("history RPC work", () => {
  it("records wallet Basis deposits even when the final program event is truncated", async () => {
    const { VAULTS, BASIS_PROGRAM } = await import("./vault-catalogue");
    const { getToken } = await import("./tokens");
    const { fetchMarginHistory } = await import("./history");
    const receipt = VAULTS.find(v=>v.id==='basis-sol')!;
    const usdc = getToken('USDC').mint.toBase58();
    const balance = (mint:string,amount:string) => ({mint,owner:wallet.toBase58(),uiTokenAmount:{amount,decimals:6}});
    rpc.getSignaturesForAddress.mockResolvedValue([{signature:'basis-deposit',confirmationStatus:'finalized',err:null}]);
    rpc.getTransaction.mockResolvedValue({blockTime:100,meta:{
      logMessages:[`Program ${BASIS_PROGRAM} invoke [1]`,'Log truncated'],
      preTokenBalances:[balance(usdc,'20000000')],
      postTokenBalances:[balance(usdc,'10000000'),balance(receipt.mint,'9500000')],
    }});
    const result = await fetchMarginHistory(wallet);
    expect(result.rows).toEqual([expect.objectContaining({type:'farm-deposit',vaultId:'basis-sol',amount:'10',receiptAmount:'9.5',signature:'basis-deposit'})]);
  });
  it("names vault receipts moved into the margin (vbSOL deposit, real fork tx bETN…GFuC)", async () => {
    // `user_deposit_collateral` of 10.144446 vbSOL from wallet 34iZ… into its margin GB1E…: the mint is
    // a Basis receipt, not a registry token, so the row used to come out with no asset and "0".
    const { fetchMarginHistory } = await import("./history");
    const owner = new PublicKey("34iZErvTLtY6K9JAmcTTbMcWFP9toSX7iXnYwpENH7XW");
    rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "bETN", confirmationStatus: "confirmed", err: null }]);
    rpc.getTransaction.mockResolvedValue({ blockTime: 1, meta: { logMessages: [
      "Program H37YVBG3eGtz89ofd7iDLc2PJgn12778392XeU2QJcGC invoke [1]",
      "Program log: Instruction: UserDepositCollateral",
      "Program data: 9D5NC4dwPWDhb16bh7ocPidDDp9Zcaqn/KaYM3vtiRtf5FcoqS7H9g6xwTvATTM7oId/2D2jLwFjwu5vfQ/F7o+PoYdIcKc6vsqaAAAAAADAzVwNAAAAAAkAAAAAAAAAv3LJagAAAAA=",
      "Program H37YVBG3eGtz89ofd7iDLc2PJgn12778392XeU2QJcGC success",
    ] } });
    const { rows } = await fetchMarginHistory(owner);
    expect(rows).toEqual([expect.objectContaining({ type: "deposit", symbol: "vbSOL", amount: "10.144446", amountRaw: 10144446n, signature: "bETN" })]);
    expect(rows[0].vaultId).toBeUndefined(); // a collateral move, not a vault deposit (no double count)
  });
  it("reads 200 finalized transactions only once across repeated refreshes", async () => {
    rpc.getSignaturesForAddress.mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ signature: `sig${i}`, confirmationStatus: "finalized", err: null, blockTime: 1 })));
    rpc.getTransaction.mockResolvedValue({ blockTime: 1, meta: { logMessages: [] } });
    await fetchEarnHistory(wallet); await fetchEarnHistory(wallet);
    expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(200);
  });
  it("deduplicates concurrent history scans", async () => {
    rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "sig", confirmationStatus: "finalized", err: null }]);
    rpc.getTransaction.mockResolvedValue({ meta: { logMessages: [] } });
    await Promise.all([fetchEarnHistory(wallet), fetchEarnHistory(wallet)]);
    expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1);
  });
  it("never caches missing transactions and marks their cost basis incomplete", async () => {
    rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "sig", confirmationStatus: "finalized", err: null }]);
    rpc.getTransaction.mockResolvedValueOnce(null).mockResolvedValue({ meta: { logMessages: [] } });
    expect((await fetchEarnHistory(wallet)).complete).toBe(false);
    expect((await fetchEarnHistory(wallet)).complete).toBe(true);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(2);
  });
  it("re-reads transactions not finalized yet", async () => {
    rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "sig", confirmationStatus: "confirmed", err: null }]);
    rpc.getTransaction.mockResolvedValue({ meta: { logMessages: [] } });
    await fetchEarnHistory(wallet); await fetchEarnHistory(wallet);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(2);
  });
  it("keeps finalized transactions across refreshes, expiring them only after hours (fork resets)", async () => {
    vi.useFakeTimers();
    rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "sig", confirmationStatus: "finalized", err: null }]);
    rpc.getTransaction.mockResolvedValue({ meta: { logMessages: [] } });
    await fetchEarnHistory(wallet);
    vi.setSystemTime(Date.now() + 300_001); // past the old 5-minute expiry: still cached
    await fetchEarnHistory(wallet);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000);
    await fetchEarnHistory(wallet);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(2);
  });
});
