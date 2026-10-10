import { describe, expect, it } from "vitest";
import type { PredictEvent, PredictOutcome, PredictPosition } from "./types";
import { buyFx, canTrade, defaultOut, groupsOf, parseRouteId, poolSide, positionRows, predictHref, quoteBuy, scenarios, twinOf } from "./view";

const out = (k: string, name: string, y: number | null, pool = { yes: 0, no: 0 }, extra: Partial<PredictOutcome> = {}): PredictOutcome => ({
  k, name, y, n: y === null ? null : 100 - y + 2, vol: 0, pool, uid: k, marketId: k, yesMint: "", noMint: "", symbol: "", image: null,
  yBid: y === null ? null : y - 2, nBid: y === null ? null : 100 - y, oi: 0, lastTradeAt: null, tradable: y !== null,
  poolDetail: { allowlisted: true, exists: true, yesDangling: 0, noDangling: 0, invested: 0, pendingMerge: 0 }, ...extra,
});
const ev = (type: PredictEvent["type"], outs: PredictOutcome[], extra: Partial<PredictEvent> = {}): PredictEvent => ({
  id: "e", type, cat: "sports", tag: "T", title: "Event", ic: "EV", last: "", ends: "", opened: "", vol: 0, v24: 0, oi: 0, source: "", rules: "",
  outs, image: null, league: null, groupedBy: "group", startMs: null, endMs: null, ...extra,
});

describe("predict view maths", () => {
  it("routes round-trip", () => {
    expect(predictHref("e1", "m1", "no")).toBe("/predict/e1~m1~no");
    expect(parseRouteId("e1~m1~no")).toEqual({ ev: "e1", mk: "m1", sd: "no" });
    expect(parseRouteId("e1")).toEqual({ ev: "e1", mk: undefined, sd: undefined });
  });

  it("pool side: the smaller side is fully paired, the larger earns on its matched part", () => {
    const o = out("m", "M", 40, { yes: 100, no: 50 });
    expect(poolSide(o, "no", 5)).toMatchObject({ share: 1, apy: 5, full: true, waiting: 0 });
    expect(poolSide(o, "yes", 5)).toMatchObject({ share: 0.5, apy: 2.5, full: false, waiting: 50 });
    // A buy of 50 more YES dilutes YES to a third paired.
    expect(poolSide(o, "yes", 6, 50).share).toBeCloseTo(1 / 3);
  });

  it("quotes at the flat ask; buys on markets outside the pool do not change it", () => {
    const o = out("m", "M", 25, { yes: 0, no: 100 });
    expect(quoteBuy(o, "yes", 50)).toEqual({ avg: 25, sh: 200 });
    expect(buyFx(o, "yes", 50, 4).after.share).toBeCloseTo(0.5);
    const off = { ...o, poolDetail: { ...o.poolDetail, allowlisted: false } };
    expect(buyFx(off, "yes", 50, 4).pairedAfter).toBe(0);
    expect(quoteBuy(out("u", "U", null), "yes", 10).sh).toBe(0);
    expect(canTrade(out("u", "U", null))).toBe(false);
  });

  it("exclusive match: one scenario per winner, best payout first", () => {
    const a = out("a", "Real Madrid", 60);
    const b = out("b", "Villarreal", 20);
    const d = out("d", "Draw", 22, undefined, { ab: "DRAW" });
    const e = ev("match", [a, b, d]);
    expect(groupsOf(e)).toHaveLength(1);
    const sc = scenarios(e, [{ k: "a", s: "yes", sh: 100 }, { k: "d", s: "yes", sh: 50 }]);
    expect(sc.map((r) => [r.label, r.pay])).toEqual([["Real Madrid wins", 100], ["Draw", 50], ["Villarreal wins", 0]]);
  });

  it("non-exclusive multi adds a 'None of them' state; independent singles multiply", () => {
    const e = ev("multi", [out("x", "X", 30), out("y", "Y", 30)], { exh: false });
    const sc = scenarios(e, [{ k: "x", s: "no", sh: 10 }]);
    expect(sc[0]).toEqual({ pay: 10, label: "Y or None of them" });
    const bin = ev("binary", [out("m", "M", 50)]);
    expect(scenarios(bin, [{ k: "m", s: "yes", sh: 7 }]).map((r) => r.pay)).toEqual([7, 0]);
  });

  it("two-team games without a draw have a twin bet; the default outcome is the leader of a multi", () => {
    const a = out("a", "A", 60);
    const b = out("b", "B", 42);
    expect(twinOf(ev("match", [a, b]), a, "no")).toMatchObject({ o: b, s: "yes" });
    expect(twinOf(ev("match", [a, b, out("d", "Draw", 10, undefined, { ab: "DRAW" })]), a, "no")).toBeNull();
    expect(defaultOut(ev("multi", [out("l", "L", 10), out("h", "H", 70), out("n", "N", null)])).k).toBe("h");
  });

  it("positions split into a pool row and a wallet row with cost by principal", () => {
    const p = {
      id: "m-yes", eventId: "e", marketId: "m", event: "E", market: "E", outcome: "M", side: "yes", label: "Yes", shares: 30, yieldShares: 0, avg: 0.5, mark: 0.6,
      value: 18, cost: 15, pnl: 3, inVault: 6, matched: 33, earned: 0, apy: 2, pays: 30, since: "", queued: 0, merging: false, src: "vanna",
      walletShares: 10, poolShares: 20, poolValueShares: 20,
    } as PredictPosition;
    const rows = positionRows([p], () => true);
    expect(rows.map((r) => [r.kind, r.src, r.shares, r.status.txt, r.canEarn])).toEqual([
      ["pool", "vanna", 20, "Earning 2.00%", false],
      ["wallet", "world", 10, "Not earning", true],
    ]);
    expect(rows[0].pnl).toBeCloseTo(20 * 0.6 - 10);
  });
});
