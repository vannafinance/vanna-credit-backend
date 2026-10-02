import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ call: vi.fn(), price: vi.fn(), consume: vi.fn() }));
vi.mock("../mcp-client", async (orig) => ({ ...(await orig<typeof import("../mcp-client")>()), mcp: { call: m.call, price: m.price } }));
vi.mock("../limits", async (orig) => ({ ...(await orig<typeof import("../limits")>()), checkAndConsume: m.consume }));

import type { ReadCtx } from "../mcp-facts";
import { humanizeFailure } from "../explain";
import { buildStepTx, loadFreshPrice, preflightStep, priceDeps, resetPriceRefresh, type Prepared } from "../workflow/steps";
import { planLever } from "../workflow/strategy";
import type { StoredStep } from "../workflow/types";
import { MAX_SWAP_HEALS, swapHealDeps } from "../workflow/swap-heal";

const ctx = { user: { wallet: "W", subject: "s", expiresAt: 0 } } as unknown as ReadCtx;

const unsignedTx = () =>
  Buffer.from(
    new VersionedTransaction(
      new TransactionMessage({ payerKey: PublicKey.default, recentBlockhash: PublicKey.default.toBase58(), instructions: [] }).compileToV0Message(),
    ).serialize(),
  ).toString("base64");

const failed = (reason: string) => ({
  simulation_success: false,
  code: "simulation_failed",
  reason,
  transactions: [{ id: "action", unsignedTransaction: unsignedTx(), simulation: { status: "failed", err: reason } }],
});
const success = () => ({
  simulation_success: true,
  summary: { action: "swap" },
  transactions: [{ id: "action", unsignedTransaction: unsignedTx(), blockhash: "bh", lastValidBlockHeight: 123, simulation: { status: "success" } }],
});

const swapCall: Prepared["call"] = { tool: "vanna_swap", args: { action: "wallet_swap", authority: "W", from_asset: "SOL", to_asset: "USDC", amount: "0.1" } };
const prepared = (call = swapCall): Prepared => ({ usd: 12, call, risk: { decision: "allow", reasons: [] }, simulation: null, resolvedAmount: "0.1", notes: [] });
const RAW_3005 = "TransactionErrorInstructionError((6, Tagged(Custom(InstructionErrorCustom(3005)))))";

beforeEach(() => {
  m.call.mockReset();
  m.price.mockReset();
  m.consume.mockReset().mockResolvedValue({ ok: true });
  swapHealDeps.heal = vi.fn(async () => 4);
  swapHealDeps.sleep = vi.fn(async () => undefined);
  resetPriceRefresh();
});

describe("a swap that failed on stale fork pools is healed and rebuilt", () => {
  it("heals the accounts of the failed envelope, then returns the rebuilt transaction", async () => {
    m.call.mockResolvedValueOnce(failed(RAW_3005)).mockResolvedValueOnce(success());
    const r = await buildStepTx(prepared(), ctx);
    expect(r.ok).toBe(true);
    expect(m.call).toHaveBeenCalledTimes(2);
    expect(swapHealDeps.heal).toHaveBeenCalledTimes(1);
    expect(m.consume).toHaveBeenCalledTimes(1); // one write-build against the rate limit, not one per retry
  });

  it("retries a slippage failure too (a fresh quote usually fits)", async () => {
    m.call.mockResolvedValueOnce(failed("custom program error: 0x1771")).mockResolvedValueOnce(success());
    expect((await buildStepTx(prepared(), ctx)).ok).toBe(true);
  });

  it("gives up after the heal budget and says so in plain words", async () => {
    m.call.mockResolvedValue(failed(RAW_3005));
    const r = await buildStepTx(prepared(), ctx);
    expect(m.call).toHaveBeenCalledTimes(1 + MAX_SWAP_HEALS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/pool data looks out of date/);
      expect(r.message).not.toMatch(/InstructionError|Custom\(|3005/);
    }
  });

  it("does not retry a genuine refusal", async () => {
    m.call.mockResolvedValue(failed("insufficient funds for this swap"));
    const r = await buildStepTx(prepared(), ctx);
    expect(m.call).toHaveBeenCalledTimes(1);
    expect(swapHealDeps.heal).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
  });

  it("only swaps are healed", async () => {
    m.call.mockResolvedValue(failed(RAW_3005));
    const r = await buildStepTx(prepared({ tool: "vanna_margin_trade", args: { action: "borrow", authority: "W", asset: "USDC", amount: "1" } }), ctx);
    expect(m.call).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
  });

  it("an envelope with no transaction still retries but heals nothing", async () => {
    swapHealDeps.heal = vi.fn(async () => 0);
    m.call.mockResolvedValueOnce({ simulation_success: false, code: "simulation_failed", reason: RAW_3005 }).mockResolvedValueOnce(success());
    expect((await buildStepTx(prepared(), ctx)).ok).toBe(true);
    expect(swapHealDeps.heal).not.toHaveBeenCalled();
  });
});

describe("swaps that cannot fit in one Solana transaction are refused up front", () => {
  const stored = (slots: Record<string, unknown>, asset = "USDC") => ({ kind: "write", op: "swap", asset, amount: "20", slots, status: "pending" }) as unknown as StoredStep;

  it("a margin swap INTO JupSOL or JitoSOL is refused before anything is built", async () => {
    for (const to of ["JupSOL", "JitoSOL"]) {
      const r = await preflightStep(stored({ to_asset: to, mode: "margin" }), ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toMatch(/inside your margin account is too large/);
        expect(r.message).toMatch(/wallet/);
      }
    }
    expect(m.call).not.toHaveBeenCalled();
  });

  it("a lever on JupSOL or JitoSOL is refused with a SOL alternative, before anything runs", async () => {
    for (const asset of ["JupSOL", "JitoSOL"]) {
      const r = await planLever({ asset, leverage: 3, borrow_asset: "USDC", amount: "1", min_hf: null } as never, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toMatch(new RegExp(`can't lever ${asset}`));
        expect(r.options?.[0]?.label).toMatch(/Lever SOL 3x instead/);
      }
    }
    expect(m.call).not.toHaveBeenCalled();
  });

  it("a size-limit error from any other pair reads as plain words", () => {
    expect(humanizeFailure("The built transaction exceeds Solana's size limit. Retry with a smaller amount or fewer route hops.")).toMatch(/too large for one Solana transaction/);
  });
});

describe("a stale oracle price is refreshed once instead of blocking the write", () => {
  beforeEach(() => {
    priceDeps.refresh = vi.fn(async () => undefined);
    priceDeps.sleep = vi.fn(async () => undefined);
    priceDeps.now = () => 1_000_000;
  });

  it("refreshes and re-reads", async () => {
    m.price.mockResolvedValueOnce({ price_usd: "120", stale: true }).mockResolvedValueOnce({ price_usd: "120", stale: false });
    const p = await loadFreshPrice("SOL", ctx);
    expect(priceDeps.refresh).toHaveBeenCalledTimes(1);
    expect(p).toEqual({ usd: 120, stale: false });
  });

  it("a fresh price never triggers a refresh", async () => {
    m.price.mockResolvedValue({ price_usd: "120", stale: false });
    await loadFreshPrice("SOL", ctx);
    expect(priceDeps.refresh).not.toHaveBeenCalled();
  });

  it("a price that is still stale after the refresh stays stale (refused downstream, not guessed)", async () => {
    m.price.mockResolvedValue({ price_usd: "120", stale: true });
    expect((await loadFreshPrice("SOL", ctx))?.stale).toBe(true);
  });

  it("throttles: a second stale read right after shares the earlier refresh", async () => {
    m.price.mockResolvedValue({ price_usd: "120", stale: true });
    await loadFreshPrice("SOL", ctx);
    await loadFreshPrice("USDC", ctx);
    expect(priceDeps.refresh).toHaveBeenCalledTimes(1);
  });

  it("a keeper failure falls back to the stale read", async () => {
    priceDeps.refresh = vi.fn(async () => {
      throw new Error("jupiter down");
    });
    m.price.mockResolvedValue({ price_usd: "120", stale: true });
    expect((await loadFreshPrice("SOL", ctx))?.stale).toBe(true);
  });
});
