import { describe, expect, it } from 'vitest';
import { historicalApy } from './nav-history';
const day = 86_400_000;
describe('observed vault APY', () => {
 it('does not fabricate seven-day yield from a new or sparse deployment',()=>{
  expect(historicalApy([{at:0,price:1}],{at:day,price:1.01},7)).toBeNull();
  expect(historicalApy([{at:0,price:1}],{at:10*day,price:1.01},7)).toBeNull();
 });
 it('annualizes actual share-price changes over the observed interval',()=>{
  expect(historicalApy([{at:0,price:1}],{at:7*day,price:1.001},7)).toBeCloseTo((1.001**(365/7)-1)*100,8);
  expect(historicalApy([{at:0,price:1}],{at:30*day,price:.99},30)).toBeLessThan(0);
 });
});
