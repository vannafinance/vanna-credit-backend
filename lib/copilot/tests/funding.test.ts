import { beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../mcp-client", async (orig) => ({ ...(await orig<typeof import("../mcp-client")>()), mcp: { wallet: async () => wallet.current } }));

import type { StepSpec } from "../plan";
import { checkFunding } from "../workflow/funding";
import type { ReadCtx } from "../mcp-facts";

const ctx = { user: { wallet: "W", subject: "s", expiresAt: 0 } } as unknown as ReadCtx;
const w = (op: string, asset: string | null, amount: string | null, slots: Record<string, string> = {}): StepSpec => ({ kind: "write", op, asset, amount, slots }) as unknown as StepSpec;
const fund = (sol: number, tokens: Record<string, number> = {}) => {
  wallet.current = { sol_balance: String(sol), assets: Object.entries(tokens).map(([symbol, b]) => ({ symbol, wallet_balance: String(b) })) };
};

describe("bug 6: an unfunded wallet gets a clear answer, not a plan", () => {
  beforeEach(() => fund(0));

  it("empty wallet, deposit 1 SOL (open account + deposit)", async () => {
    const msg = await checkFunding([w("create_account", null, null), w("deposit", "SOL", "1")], ctx);
    expect(msg).toMatch(/needs? about 0\.05 SOL|about 0\.05 SOL/);
  });

  it("has fee SOL but not enough USDC", async () => {
    fund(1, { USDC: 20 });
    const msg = await checkFunding([w("earn_supply", "USDC", "50")], ctx);
    expect(msg).toMatch(/has 20 USDC, but this needs 50 USDC/);
  });

  it("SOL spend keeps the fee reserve back", async () => {
    fund(1);
    expect(await checkFunding([w("deposit", "SOL", "0.99")], ctx)).toMatch(/about 0\.05 SOL stays back/);
    expect(await checkFunding([w("deposit", "SOL", "0.9")], ctx)).toBeNull();
  });

  it("two steps spending the same asset are added up", async () => {
    fund(1, { USDC: 60 });
    expect(await checkFunding([w("earn_supply", "USDC", "40"), w("deposit", "USDC", "40")], ctx)).toMatch(/needs 80 USDC/);
  });

  it("a step after a borrow is not checked (the borrow brings funds in)", async () => {
    fund(1);
    expect(await checkFunding([w("borrow", "USDC", "50"), w("earn_supply", "USDC", "50")], ctx)).toBeNull();
  });

  it("repay from margin and withdraw never need wallet funds", async () => {
    fund(1);
    expect(await checkFunding([w("repay", "USDC", "10", { source: "margin" })], ctx)).toBeNull();
    expect(await checkFunding([w("withdraw", "SOL", "1")], ctx)).toBeNull();
  });
});
