import { describe, expect, it } from 'vitest';
import { DAY, historicalApy } from './nav-math';
import { apyText, depositPrice, eventApy, grossFundingApr, netYield } from './yield';

describe('vault yield availability and fallback', () => {
  it('shows the zero form for missing history, and measured zero / loss as they are', () => {
    expect(apyText(null)).toBe('0.00%');
    expect(apyText(undefined, 1)).toBe('0.0%');
    expect(apyText(0)).toBe('0.00%');
    expect(apyText(-3)).toBe('-3.00%');
    expect(apyText(NaN)).toBe('0.00%');
  });
  it('does not produce realized 7D yield from a new deployment', () => {
    const current = { at: DAY, price: 1.01 };
    const points = [{ at: 0, price: 1 }];
    expect(historicalApy(points, current, 7)).toBeNull();
    expect(eventApy(points, current, 7)).toBeNull();
  });
  it('uses the newest qualifying event and its actual elapsed interval', () => {
    const points = [{ at: 0, price: 1 }, { at: 2 * DAY, price: 1.01 }, { at: 9 * DAY, price: 1.02 }];
    const result = eventApy(points, { at: 10 * DAY, price: 1.02 }, 7)!;
    expect(result.baselineAt).toBe(2 * DAY);
    expect(result.value).toBeCloseTo(((1.02 / 1.01) ** (365 / 8) - 1) * 100);
    expect(eventApy(points, { at: 10 * DAY, price: 1.02 }, 30)).toBeNull();
  });
  it('derives a baseline from net value added, not nominal USDC sent', () => {
    expect(depositPrice(9_980_000n, 10_000_000n)).toBe(.998);
    expect(depositPrice(0n, 10_000_000n)).toBeNull();
    expect(depositPrice(10n, 1n)).toBeNull();
  });
  it('does not invent zero or negative net returns from unavailable inputs', () => {
    expect(netYield(null, 5, 1)).toBeNull();
    expect(netYield(12, null, 1)).toBeNull();
    expect(netYield(12, null, 0)).toBe(12);
    expect(netYield(12, 5, .4)).toBe(10);
    expect(netYield(0, 5, 1)).toBe(-5);
  });
  it('keeps gross funding APR independent from realized APY, including negative rates', () => {
    expect(grossFundingApr(30, 500, 1000)).toBe(15);
    expect(grossFundingApr(-10, 1100, 1000)).toBe(-11);
    expect(grossFundingApr(30, 500, 0)).toBeNull();
    expect(grossFundingApr(null, 500, 1000)).toBeNull();
  });
});
