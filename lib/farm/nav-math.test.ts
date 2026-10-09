import { describe, expect, it } from "vitest";
import { DAY, HOUR, dailyApy, dailySamples, fundingDays, fundingStats, navStats, shortLiquidationRise } from "./nav-math";

describe("vault page maths", () => {
  it("returns no history-derived figures for a new vault", () => {
    const s = navStats([{ at: 0, price: 1 }]);
    expect(s.sinceLaunch).toBeNull();
    expect(s.roi).toBeNull();
    expect(s.sharpe).toBeNull();
    expect(s.apy90).toBeNull();
    expect(navStats([]).firstAt).toBeNull();
  });

  it("samples the last observation of each UTC day and annualises day over day", () => {
    const pts = [
      { at: 1 * HOUR, price: 1 },
      { at: 23 * HOUR, price: 1.0001 },
      { at: DAY + HOUR, price: 1.0002 },
    ];
    const days = dailySamples(pts);
    expect(days).toEqual([
      { at: 0, value: 1.0001 },
      { at: DAY, value: 1.0002 },
    ]);
    expect(dailyApy(days)[0].value).toBeCloseTo((Math.pow(1.0002 / 1.0001, 365) - 1) * 100, 8);
  });

  it("measures drawdown, ROI and since-launch from recorded points only", () => {
    const pts = [
      { at: 0, price: 1 },
      { at: DAY, price: 1.01 },
      { at: 2 * DAY, price: 0.99 },
      { at: 3 * DAY, price: 1.02 },
    ];
    const s = navStats(pts);
    expect(s.maxDrawdown).toBeCloseTo((0.99 / 1.01 - 1) * 100, 8);
    expect(s.roi).toBeCloseTo(2, 8);
    expect(s.sinceLaunch).toBeCloseTo((Math.pow(1.02, 365 / 3) - 1) * 100, 6);
    expect(s.sharpe).not.toBeNull();
  });

  it("aggregates Phoenix hourly funding per day and counts negative days", () => {
    const rates = [
      { at: 0, pct: 0.001 },
      { at: HOUR, pct: 0.003 },
      { at: DAY, pct: -0.002 },
    ];
    const days = fundingDays(rates);
    expect(days.map((d) => d.hours)).toEqual([2, 1]);
    expect(days[0].apr).toBeCloseTo(0.002 * 8760, 8);
    const st = fundingStats(days);
    expect(st.negativeDays30).toBe(1);
    expect(st.days30).toBe(2);
    expect(st.avg30).toBeCloseTo(((0.001 + 0.003 - 0.002) / 3) * 8760, 8);
  });

  it("derives the short's liquidation rise from Phoenix's margin view", () => {
    expect(shortLiquidationRise(0, 100, 2)).toBeNull();
    expect(shortLiquidationRise(100, null, 2)).toBeNull();
    expect(shortLiquidationRise(100, 102, 2)).toBeCloseTo((100 / 102) * 100, 8);
  });
});
