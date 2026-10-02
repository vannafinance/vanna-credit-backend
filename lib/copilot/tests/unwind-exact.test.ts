import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  accountHealth: vi.fn(),
  call: vi.fn(),
  earnPosition: vi.fn(),
  wallet: vi.fn(),
  swapQuote: vi.fn(),
  price: vi.fn(),
}));
vi.mock("../mcp-client", async (orig) => ({ ...(await orig<typeof import("../mcp-client")>()), mcp: m }));

import type { ReadCtx } from "../mcp-facts";
import { priceDeps } from "../mcp-facts";
import { labelFor } from "../plan";
import { keywordRoute } from "../router";
import { sizeExactOut } from "../workflow/steps";
import { planUnwind } from "../workflow/unwind";

const ctx = { user: { wallet: "W", subject: "s", expiresAt: 0 } } as unknown as ReadCtx;

const row = (symbol: string, units: number, px: number, key: "ui_balance" | "ui_debt") => ({ symbol, [key]: String(units), usd_value: String(units * px), price: { usd: String(px) } });
const health = (collateral: Array<[string, number, number]>, debt: Array<[string, number, number]> = []) => {
  const c = collateral.map(([s, u, p]) => row(s, u, p, "ui_balance"));
  const d = debt.map(([s, u, p]) => row(s, u, p, "ui_debt"));
  const cu = collateral.reduce((t, [, u, p]) => t + u * p, 0);
  const du = debt.reduce((t, [, u, p]) => t + u * p, 0);
  return { health_factor: du > 0 ? String(cu / du) : null, total_collateral_usd: String(cu), total_debt_usd: String(du), collateral: c, debt: d, margin_account: "M" };
};
const walletOf = (sol: number, tokens: Record<string, number> = {}) => ({ sol_balance: String(sol), assets: Object.entries(tokens).map(([symbol, b]) => ({ symbol, wallet_balance: String(b) })) });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.call.mockResolvedValue({ positions: [] });
  m.earnPosition.mockResolvedValue({ share_balance: "0", redeemable_underlying: "0" });
  m.wallet.mockResolvedValue(walletOf(1));
  priceDeps.refresh = vi.fn(async () => undefined);
  priceDeps.sleep = vi.fn(async () => undefined);
});

describe("routing: unwind", () => {
  const unwind = (p: string) => {
    const r = keywordRoute(p);
    expect(r.lane).toBe("unwind");
    return (r as Extract<typeof r, { lane: "unwind" }>).unwind;
  };
  it.each([
    ["close everything", "all", false],
    ["unwind my positions", "all", false],
    ["close all my positions", "all", false],
    ["exit everything", "all", false],
    ["close everything and unwind my positions", "all", false],
    ["close out my margin positions", "margin", false],
    ["unwind my earn positions", "earn", false],
    ["exit my kamino positions", "farm", false],
    ["close everything including my account", "all", true],
  ])("%s -> %s", (p, scope, close) => {
    expect(unwind(p)).toEqual({ scope, close_account: close });
  });

  it("closing just the account is still the account action", () => {
    const r = keywordRoute("close my margin account");
    expect(r.lane).toBe("write");
  });

  it("a conditional unwind is refused, not run now", () => {
    expect(keywordRoute("if SOL drops below 100 close everything").lane).toBe("refuse");
  });
});

describe("planUnwind: the exit order keeps health improving", () => {
  it("Kamino first, then repay from margin, then withdraw, then Earn", async () => {
    m.accountHealth.mockResolvedValue(health([["SOL", 2, 120], ["USDC", 50, 1], ["kSOL", 86.6, 1.39]], [["USDC", 30, 1]]));
    m.call.mockResolvedValue({ positions: [{ symbol: "kSOL", receipt_balance: "86.6", underlying_amount: "0.1" }] });
    m.earnPosition.mockImplementation(async (_w: string, a: string) => (a === "USDT" ? { share_balance: "5", redeemable_underlying: "5" } : { share_balance: "0", redeemable_underlying: "0" }));
    const r = await planUnwind({ scope: "all", close_account: false }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps.map((s) => `${s.op}:${s.asset}:${s.amount}${s.slots.source ? ":" + s.slots.source : ""}`)).toEqual([
      "farm_redeem:SOL:all",
      "repay:USDC:all:margin",
      "withdraw:SOL:all",
      "withdraw:USDC:all",
      "earn_redeem:USDT:all",
    ]);
    expect(r.plan.summary).toMatch(/^Unwind: /);
  });

  it("repays from the wallet when the margin balance is short but the wallet covers it", async () => {
    m.accountHealth.mockResolvedValue(health([["SOL", 2, 120]], [["USDC", 30, 1]]));
    m.wallet.mockResolvedValue(walletOf(1, { USDC: 100 }));
    const r = await planUnwind({ scope: "margin", close_account: false }, ctx);
    expect(r.ok && r.plan.steps.map((s) => `${s.op}:${s.asset}:${s.slots.source ?? ""}`)).toEqual(["repay:USDC:wallet", "withdraw:SOL:"]);
  });

  it("swaps collateral into the debt asset when neither balance covers it, then repays from margin", async () => {
    m.accountHealth.mockResolvedValue(health([["SOL", 2, 120]], [["USDC", 30, 1]]));
    m.wallet.mockResolvedValue(walletOf(1, { USDC: 0 }));
    const r = await planUnwind({ scope: "margin", close_account: false }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [swap, repay, withdraw] = r.plan.steps;
    expect(swap).toMatchObject({ op: "swap", asset: "SOL", slots: { to_asset: "USDC", mode: "margin" } });
    expect(swap.amount).toMatch(/^out:30\.\d+/);
    expect(repay).toMatchObject({ op: "repay", asset: "USDC", amount: "all", slots: { source: "margin" } });
    expect(withdraw).toMatchObject({ op: "withdraw", asset: "SOL" });
    expect(r.plan.warnings.join(" ")).toMatch(/swapped into about/);
  });

  it("refuses honestly when the debt cannot be covered from any balance", async () => {
    m.accountHealth.mockResolvedValue(health([["SOL", 0.1, 120]], [["USDC", 30, 1]]));
    m.wallet.mockResolvedValue(walletOf(1, { USDC: 0 }));
    const r = await planUnwind({ scope: "margin", close_account: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/can't fully repay your 30 USDC debt/);
  });

  it("closes the account last only when asked", async () => {
    m.accountHealth.mockResolvedValue(health([["SOL", 1, 120]]));
    const r = await planUnwind({ scope: "all", close_account: true }, ctx);
    expect(r.ok && r.plan.steps.map((s) => s.op)).toEqual(["withdraw", "close_account"]);
  });

  it("nothing open: says so", async () => {
    m.accountHealth.mockResolvedValue(health([]));
    const r = await planUnwind({ scope: "all", close_account: false }, ctx);
    expect(r).toEqual({ ok: false, message: "You have no open positions to close." });
  });

  it("an unreadable account is not unwound from partial data", async () => {
    m.accountHealth.mockRejectedValue(new Error("rpc down"));
    const r = await planUnwind({ scope: "all", close_account: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/won't draw up an exit plan from partial data/);
  });

  it("caps at 8 steps without cutting between a swap and its repay", async () => {
    m.accountHealth.mockResolvedValue(
      health([["SOL", 5, 120], ["JitoSOL", 1, 150], ["JupSOL", 1, 140], ["USDT", 10, 1]], [["USDC", 100, 1]]),
    );
    m.call.mockResolvedValue({
      positions: [
        { symbol: "kSOL", receipt_balance: "10", underlying_amount: "0.1" },
        { symbol: "kJitoSOL", receipt_balance: "10", underlying_amount: "0.1" },
        { symbol: "kJupSOL", receipt_balance: "10", underlying_amount: "0.1" },
        { symbol: "kUSDT", receipt_balance: "10", underlying_amount: "1" },
      ],
    });
    m.wallet.mockResolvedValue(walletOf(1, { USDC: 0 }));
    const r = await planUnwind({ scope: "margin", close_account: false }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps.length).toBeLessThanOrEqual(8);
    expect(r.plan.steps.at(-1)?.op).not.toBe("swap");
    expect(r.plan.warnings.join(" ")).toMatch(/Ask again afterwards/);
  });
});

describe("exact-output swaps", () => {
  it.each([
    ["swap SOL to get 100 USDC", "SOL", "USDC", "100"],
    ["buy 100 USDC with SOL", "SOL", "USDC", "100"],
    ["swap USDC to receive exactly 2 SOL", "USDC", "SOL", "2"],
    ["get at least 50 USDT by selling SOL", "SOL", "USDT", "50"],
  ])("%s routes to a swap sized by the output", (p, from, to, value) => {
    const r = keywordRoute(p);
    expect(r.lane).toBe("write");
    if (r.lane === "write") expect(r.write).toMatchObject({ op: "swap", asset: from, to_asset: to, amount: { kind: "out", value } });
  });

  it("an ordinary swap still spends the stated input", () => {
    const r = keywordRoute("swap 1 SOL to USDC");
    expect(r.lane === "write" && r.write.amount).toEqual({ kind: "exact", value: "1" });
  });

  it("sizes the input so the quoted minimum covers the target", async () => {
    m.price.mockImplementation(async (a: string) => ({ price_usd: a === "SOL" ? "120" : "1", stale: false }));
    // First quote is short of 100 after slippage; the second, corrected input clears it.
    m.swapQuote.mockResolvedValueOnce({ min_out_amount: "99.2" }).mockResolvedValueOnce({ min_out_amount: "100.4" });
    const r = await sizeExactOut("SOL", "USDC", 100, 100, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number(r.minOut)).toBeGreaterThanOrEqual(100);
    expect(m.swapQuote).toHaveBeenCalledTimes(2);
    const first = Number(m.swapQuote.mock.calls[0][0].amount);
    expect(first).toBeGreaterThan(100 / 120); // starts above the bare price ratio (slippage allowance)
  });

  it("the card names the target, not a made-up input", () => {
    expect(labelFor({ kind: "write", op: "swap", asset: "SOL", amount: "out:100", slots: { to_asset: "USDC", mode: "wallet" } })).toBe(
      "Swap SOL to receive at least 100 USDC in your wallet",
    );
  });
});
