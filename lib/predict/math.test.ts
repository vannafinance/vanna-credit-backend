import { describe, expect, it } from "vitest";
import { buyShares, countdown, fillPrice, maxSharesForAssets, poolBar, previewRedeemValue, pricesFromFills, redeemSwapSlack, sellCash, sharesForAssets, sizeRedeem, timeAgo, toCents } from "./math";

describe("pricesFromFills", () => {
  it("has no price without fills; windows open at 50/50", () => {
    expect(pricesFromFills({}, "binary", null).source).toBe("none");
    expect(pricesFromFills({}, "updown", 1)).toMatchObject({ yesAsk: 0.51, noAsk: 0.51, yesBid: 0.49, noBid: 0.49, source: "reference" });
  });
  it("derives the other side from YES + NO = 1 with the synthetic spread", () => {
    const p = pricesFromFills({ yesBuy: { price: 0.6, ts: 1000 } }, "binary", null);
    expect(p.yesAsk).toBeCloseTo(0.6);
    expect(p.noAsk).toBeCloseTo(0.41);
    expect(p.yesBid!).toBeLessThan(p.yesAsk!);
    expect(p.noBid!).toBeLessThan(p.noAsk!);
    expect(p.yesBid! + p.noAsk!).toBeLessThanOrEqual(1.0000001);
  });
  it("keeps the newer side when stale fills disagree", () => {
    const p = pricesFromFills({ yesBuy: { price: 0.8, ts: 10_000_000 }, noBuy: { price: 0.6, ts: 1 } }, "binary", null);
    expect(p.yesAsk).toBeCloseTo(0.8);
    expect(p.noAsk).toBeCloseTo(0.21); // 1 − 0.8 + half spread, the stale 0.6 is dropped
  });
  it("never crosses bid over ask", () => {
    const p = pricesFromFills({ yesBuy: { price: 0.5, ts: 1 }, yesSell: { price: 0.55, ts: 1 } }, "binary", null);
    expect(p.yesBid!).toBeLessThan(p.yesAsk!);
  });
});

describe("fills and sizing", () => {
  it("prices a fill as CASH / tokens and drops dust / foreign-currency trades", () => {
    expect(fillPrice(-430_000, 1_000_000)).toBeCloseTo(0.43);
    expect(fillPrice(-10, 1_000_000_000)).toBeNull();
    expect(fillPrice(-2_000_000, 1_000_000)).toBeNull();
    expect(fillPrice(-1_020_000, 1_030_000)).toBeCloseTo(0.99, 2);
  });
  it("sizes buys and sells in raw units", () => {
    expect(buyShares(10_000_000n, 0.4)).toBe(25_000_000n);
    expect(sellCash(25_000_000n, 0.38)).toBe(9_500_000n);
    expect(toCents(0.4567)).toBe(45.7);
    expect(toCents(null)).toBeNull();
  });
});

describe("pool share maths", () => {
  // 1 outcome unit (6 dec) mints ~1000 share units (9 dec) at par.
  const dangling = 40_000_000n, invested = 60_000_000n, supply = 100_000_000_000n;
  it("previewRedeemValue matches to_assets_down", () => {
    expect(previewRedeemValue(1_000_000_000n, dangling, invested, supply)).toBe((1_000_000_000n * (100_000_000n + 1n)) / (supply + 1000n));
    expect(previewRedeemValue(0n, dangling, invested, supply)).toBe(0n);
  });
  it("sharesForAssets is the smallest share amount covering the target", () => {
    const need = 12_345_678n;
    const s = sharesForAssets(need, supply, dangling, invested, supply);
    expect(previewRedeemValue(s, dangling, invested, supply)).toBeGreaterThanOrEqual(need);
    expect(previewRedeemValue(s - 1n, dangling, invested, supply)).toBeLessThan(need);
  });
  it("caps at the shares held", () => {
    expect(sharesForAssets(10n ** 12n, 5n, dangling, invested, supply)).toBe(5n);
  });
  it("pool bar: min(yes, no) = lent + pending pairs", () => {
    const bar = poolBar(30, 10, 100);
    expect(Math.min(bar.yes, bar.no)).toBe(110);
  });
});

describe("formatting", () => {
  it("timeAgo / countdown", () => {
    expect(timeAgo(0)).toBe("");
    expect(timeAgo(1000, 61_000)).toBe("1m ago");
    expect(countdown(90_061_000, 0)).toBe("1d 1h");
    expect(countdown(125_000, 0)).toBe("2m 05s");
  });
});

describe("sizeRedeem (redeem.rs SwapAmountMismatch window)", () => {
  // The program's check, against the shortfall it computes after its reserve refresh.
  const passes = (usdcIn: bigint, shares: bigint, dangling: bigint, investedAtLanding: bigint, supply: bigint) => {
    const v = previewRedeemValue(shares, dangling, investedAtLanding, supply);
    if (v <= dangling) return true; // no swap: swap_data ignored
    const shortfall = v - dangling;
    return usdcIn >= shortfall && usdcIn - shortfall <= redeemSwapSlack(shortfall);
  };

  it("an exact-at-read route fails once interest accrues; the sized route covers it (live fork numbers)", () => {
    // 2026-10-11 hosted fork, Verstappen pool: invested grew 2 units between read and execution.
    const [shares, supply, read, landed] = [882_436_611_335n, 1_354_903_653_201n, 1_353_702_039n, 1_353_702_041n];
    const exact = previewRedeemValue(shares, 0n, read, supply);
    expect(passes(exact, shares, 0n, landed, supply)).toBe(false);
    const r = sizeRedeem(shares, 0n, read, read + 40_000n, supply);
    expect(r.shares).toBe(shares);
    expect(r.value).toBe(exact);
    for (const inv of [read, landed, read + 20_000n, read + 40_000n]) expect(passes(r.usdcIn, shares, 0n, inv, supply)).toBe(true);
  });

  it("small redeems stay inside the window too and never overshoot the slack", () => {
    const r = sizeRedeem(1_000_000n, 0n, 1_000_000_000n, 1_000_001_000n, 1_000_000_000_000n);
    expect(passes(r.usdcIn, 1_000_000n, 0n, 1_000_000_000n, 1_000_000_000_000n)).toBe(true);
    expect(passes(r.usdcIn, 1_000_000n, 0n, 1_000_001_000n, 1_000_000_000_000n)).toBe(true);
  });

  it("no route when dangling covers the redeem even at the horizon", () => {
    expect(sizeRedeem(1_000_000n, 5_000_000n, 1_000_000n, 1_000_100n, 6_000_000_000n).usdcIn).toBe(0n);
  });

  it("caps the route at the slack when projected accrual exceeds it", () => {
    const r = sizeRedeem(500_000_000_000n, 0n, 1_000_000_000n, 1_100_000_000n, 1_000_000_000_000n);
    const shortfall = r.value;
    expect(r.usdcIn).toBe(shortfall + redeemSwapSlack(shortfall));
  });

  it("trims a side's last holder so the projected shortfall stays fundable from the pool", () => {
    const supply = 1_000_000_000_000n;
    const [now, ahead] = [1_000_000_000n, 1_000_050_000n];
    const r = sizeRedeem(supply, 0n, now, ahead, supply);
    expect(r.shares).toBeLessThan(supply);
    expect(r.usdcIn).toBeLessThanOrEqual(now);
    expect(passes(r.usdcIn, r.shares, 0n, ahead, supply)).toBe(true);
    expect(passes(r.usdcIn, r.shares, 0n, now, supply)).toBe(true);
  });

  it("maxSharesForAssets is the exact inverse bound", () => {
    for (const [a, d, i, s] of [[100n, 0n, 1_000n, 1_000_000n], [123_456n, 7n, 999_999n, 10n ** 12n]]) {
      const m = maxSharesForAssets(a, 10n ** 15n, d, i, s);
      expect(previewRedeemValue(m, d, i, s)).toBeLessThanOrEqual(a);
      expect(previewRedeemValue(m + 1n, d, i, s)).toBeGreaterThan(a);
    }
  });
});
