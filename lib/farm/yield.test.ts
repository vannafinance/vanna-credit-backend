import { describe, expect, it } from 'vitest';
import { DAY, historicalApy } from './nav-math';
import { LOW_TVL_USD, apyText, daysText, depositPrice, eventApy, grossFundingApr, netYield, sinceLaunchLabel, vaultApy } from './yield';

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

describe('vaultApy (Basis headline APY)', () => {
  it('uses the realized 7D APY when it exists, with funding beside it', () => {
    expect(vaultApy(12.5, 30, 50_000, 100_000)).toEqual({ value: 12.5, estimate: false, source: '7d', fundingApr: 30, lowTvl: false });
  });
  it('falls back to the funding estimate on the short share, labelled as an estimate', () => {
    expect(vaultApy(null, 30, 50_000, 100_000)).toEqual({ value: 15, estimate: true, source: 'funding', fundingApr: 30, lowTvl: false });
  });
  it('has no value without funding data', () => {
    expect(vaultApy(undefined, null, 500, 1000)).toEqual({ value: null, estimate: false, source: null, fundingApr: null, lowTvl: true });
  });
  it('flags a NAV under $10K as low TVL', () => {
    expect(vaultApy(null, 25, 900, 1000).lowTvl).toBe(true);
    expect(vaultApy(null, 25, 9_000, LOW_TVL_USD).lowTvl).toBe(false);
  });
});

describe('since-launch return is never annualised', () => {
  it('keeps a positive funding estimate as headline while history is under 7 days', () => {
    // SOL Basis: share price 0.983 after 4 days would annualise to about −79%; funding is +25% APR.
    const apy = vaultApy(null, 25, 1_000, 1_000);
    expect(apy.value).toBe(25);
    expect(apy.source).toBe('funding');
  });
  it('labels the raw return with its history length', () => {
    expect(sinceLaunchLabel(-1.7, 4.2)).toBe('Since launch \u22121.70% · 4 days');
    expect(sinceLaunchLabel(0.06, 1)).toBe('Since launch +0.06% · 1 day');
    expect(sinceLaunchLabel(0.06, 0.5)).toBe('Since launch +0.06% · under 1 day');
    expect(sinceLaunchLabel(null, 4)).toBeNull();
    expect(sinceLaunchLabel(1, null)).toBeNull();
    expect(daysText(7.9)).toBe('7 days');
  });
});
