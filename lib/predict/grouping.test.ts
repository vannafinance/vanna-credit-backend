import { describe, expect, it } from "vitest";
import { classify, commonTitle, dateTemplate, familyId, groupMarkets, levelTemplate, parseVs, parseWins, questionFrom, subjectTemplate } from "./grouping";
import type { MarketInfo } from "./types";

/**
 * Fixtures are real World mainnet markets (names / symbols / questions / images as served on
 * 2026-10-10); ids are shortened.
 */
let n = 0;
function mk(p: Partial<MarketInfo> & { name: string }): MarketInfo {
  n++;
  return {
    id: p.id ?? `m${n}`,
    yesMint: `y${n}`,
    noMint: `n${n}`,
    vault: `v${n}`,
    resolutionKind: 5,
    startMs: null,
    endMs: null,
    symbol: "",
    question: `${p.name.replace(/ \(Yes\)$/, "")}?`,
    description: null,
    image: null,
    category: "sports",
    league: null,
    groupId: null,
    ...p,
  };
}
const q = (question: string) => ({ question, description: `Resolves YES if the answer to "${question}" is yes; otherwise NO.` });

describe("helpers", () => {
  it("classifies from World's image folders and falls back to symbols", () => {
    expect(classify(undefined, { image: "https://m.world.xyz/nfl/brav.png" })).toEqual({ category: "sports", league: "NFL" });
    expect(classify(undefined, { image: "https://m.world.xyz/politics/kamala-harris.png" }).category).toBe("politics");
    expect(classify(undefined, { image: "https://m.world.xyz/img/finance.png" })).toEqual({ category: "economics", league: "Finance" });
    expect(classify({ name: "BTC Up", symbol: "BTC-UP" }, undefined).category).toBe("crypto");
    expect(classify({ name: "NOR vs ENG: ENG wins (YES)", symbol: "ENGwNOR-Y" }, undefined)).toEqual({ category: "sports", league: "World Cup" });
  });
  it("extracts the question", () => {
    expect(questionFrom({ name: "Hoffenheim (Yes)" }, { description: 'Resolves YES if the answer to "Will Hoffenheim win?" is yes; otherwise NO.' })).toBe("Will Hoffenheim win?");
    expect(questionFrom({ name: "Mercedes wins CC26" }, { description: "Resolves YES if Mercedes wins Formula 1 2026 Constructors' Championship; otherwise NO." })).toBe("Will Mercedes wins Formula 1 2026 Constructors' Championship?");
    expect(questionFrom({ name: "ARG wins WC26" }, undefined)).toBe("ARG wins WC26?");
  });
  it("finds level phrases without touching years", () => {
    expect(levelTemplate("Will Bitcoin trade above $99,999.99 at any point in 2026?")).toMatchObject({ template: "Will Bitcoin trade {lvl} at any point in 2026?", level: 99999.99, dir: "up" });
    expect(levelTemplate("Will Bitcoin trade below $45,000 at any point in 2026?")).toMatchObject({ dir: "down", level: 45000 });
    expect(levelTemplate("Will the Nasdaq 100 Index close between 19,000 and 19,499.99 at year-end 2026?")).toMatchObject({ template: "Will the Nasdaq 100 Index close {lvl} at year-end 2026?", dir: "range", text: "19,000 to 19,499.99" });
    expect(levelTemplate("Will the Nasdaq 100 Index close above 33,000 at year-end 2026?")!.template).toBe("Will the Nasdaq 100 Index close {lvl} at year-end 2026?");
    expect(levelTemplate("Will WTI crude oil trade at $115.01 or above at any point in 2026?")).toMatchObject({ dir: "up", level: 115.01 });
    expect(levelTemplate("Will US year-over-year CPI inflation exceed 4.5% at any point in 2026?")).toMatchObject({ level: 4.5 });
    expect(levelTemplate("Will Elon Musk's net worth be above $1.4 trillion at year-end 2026?")!.level).toBe(1.4e12);
    expect(levelTemplate("Will Kamala Harris win the 2028 US Presidential Election?")).toBeNull();
  });
  it("finds deadlines", () => {
    expect(dateTemplate("Will the US end the Iran blockade by Oct 31?")).toEqual({ template: "Will the US end the Iran blockade by {date}?", date: "Oct 31" });
    expect(dateTemplate("Will an acquisition of PayPal be announced before 2027?")).toBeNull();
  });
  it("templates by subject, refusing generic ones", () => {
    expect(subjectTemplate("Will Josh Shapiro win the 2028 Democratic presidential nomination?", "Josh Shapiro")).toBe("Will {} win the 2028 Democratic presidential nomination?");
    expect(subjectTemplate("Will Barcelona win?", "Barcelona")).toBeNull();
    expect(subjectTemplate("Andre Fili?", "Andre Fili")).toBeNull();
    expect(subjectTemplate("Bitcoin above $200,000 in 2026?", "Yes")).toBeNull();
  });
  it("parses vs / wins names", () => {
    expect(parseVs("NOR vs ENG: ENG wins (YES)")).toEqual({ home: "NOR", away: "ENG", pick: "ENG" });
    expect(parseVs("USA vs BIH: Draw (YES)")).toEqual({ home: "USA", away: "BIH", pick: "Draw" });
    expect(parseWins("Lando Norris wins DC26", "Resolves YES if Lando Norris wins Formula 1 2026 Drivers' Championship; otherwise NO.")).toEqual({ subject: "Lando Norris", code: "DC26", eventName: "Formula 1 2026 Drivers' Championship" });
    expect(parseWins("ESP wins WC26", null)).toEqual({ subject: "ESP", code: "WC26", eventName: null });
  });
  it("titles", () => {
    expect(commonTitle(["Will ARI Cardinals win the 2026 NFL championship?", "Will BUF Bills win the 2026 NFL championship?"])).toBe("Who will win the 2026 NFL championship?");
    expect(commonTitle(["Will the Fed make exactly 0 rate cuts in 2026?", "Will the Fed make exactly 1 rate cuts in 2026?"])).toBe("Will the Fed make exactly … rate cuts in 2026?");
    expect(familyId("tpl:x")).toMatch(/^f-[0-9a-z]+$/);
    expect(familyId("tpl:x")).toBe(familyId("tpl:x"));
  });
});

describe("groupMarkets", () => {
  it("a World Group with home / away / draw is one match", () => {
    const home = mk({ name: "Aston Villa (Yes)", symbol: "AVIL-Y", ...q("Will Aston Villa win?"), league: "UCL", groupId: "G1" });
    const away = mk({ name: "Fenerbahce (Yes)", symbol: "FENE-Y", ...q("Will Fenerbahce win?"), league: "UCL", groupId: "G1" });
    const draw = mk({ name: "Draw (Yes)", symbol: "DRAW-Y", ...q("Will this match end in a draw?"), league: "Soccer", groupId: "G1" });
    const [e] = groupMarkets([draw, home, away], new Map([["G1", [home.id, away.id, draw.id]]]));
    expect(e).toMatchObject({ id: "G1", type: "match", groupedBy: "group", title: "Aston Villa vs Fenerbahce", tag: "UCL" });
    expect(e.outcomes.map((o) => [o.name, o.ab])).toEqual([["Aston Villa", "AVIL"], ["Fenerbahce", "FENE"], ["Draw", "DRAW"]]);
    expect(e.exh).toBeUndefined();
  });
  it("an NFL game Group can tie (exh false)", () => {
    const a = mk({ name: "LV Raiders (Yes)", symbol: "LRAI-Y", ...q("Will LV Raiders win?"), league: "NFL", groupId: "G2" });
    const b = mk({ name: "NE Patriots (Yes)", symbol: "NPAT-Y", ...q("Will NE Patriots win?"), league: "NFL", groupId: "G2" });
    const [e] = groupMarkets([a, b], new Map([["G2", [a.id, b.id]]]));
    expect(e).toMatchObject({ type: "match", title: "LV Raiders vs NE Patriots", exh: false });
  });
  it("a large World Group is a multi titled from the shared question", () => {
    const teams = ["ARI Cardinals", "ATL Falcons", "BUF Bills", "BAL Ravens"].map((t) => mk({ name: `${t} (Yes)`, ...q(`Will ${t} win the 2026 NFL championship?`), league: "NFL", groupId: "G3" }));
    const [e] = groupMarkets(teams, new Map([["G3", teams.map((t) => t.id)]]));
    expect(e).toMatchObject({ type: "multi", groupedBy: "group", title: "Who will win the 2026 NFL championship?" });
    expect(e.outcomes).toHaveLength(4);
  });
  it("nomination candidates (no Group on chain) group by question template", () => {
    const c = ["Kamala Harris", "Gavin Newsom", "Josh Shapiro"].map((s) => mk({ name: `${s} (Yes)`, category: "politics", ...q(`Will ${s} win the 2028 Democratic presidential nomination?`) }));
    const other = mk({ name: "Gavin Newsom (Yes)", category: "politics", ...q("Will Gavin Newsom win the 2028 US Presidential Election?") });
    const events = groupMarkets([...c, other], new Map());
    const dem = events.find((e) => e.outcomes.length === 3)!;
    expect(dem).toMatchObject({ type: "multi", groupedBy: "template", title: "Who will win the 2028 Democratic presidential nomination?" });
    expect(dem.exh).toBeUndefined();
    expect(events.find((e) => e.outcomes.length === 1)).toMatchObject({ type: "binary", groupedBy: "single" });
  });
  it("non-exclusive template families can all lose", () => {
    const c = ["John Brennan", "James Clapper"].map((s) => mk({ name: `${s} (Yes)`, category: "politics", ...q(`Will ${s} be arrested in 2026?`) }));
    expect(groupMarkets(c, new Map())[0]).toMatchObject({ title: "Who will be arrested in 2026?", exh: false });
  });
  it("price levels form a strike ladder (↑ high→low, then ↓)", () => {
    const ladder = [
      mk({ name: "Below $45,000 (Yes)", category: "crypto", ...q("Will Bitcoin trade below $45,000 at any point in 2026?") }),
      mk({ name: "Above $99,999.99 (Yes)", category: "crypto", ...q("Will Bitcoin trade above $99,999.99 at any point in 2026?") }),
      mk({ name: "Above $119,999.99 (Yes)", category: "crypto", ...q("Will Bitcoin trade above $119,999.99 at any point in 2026?") }),
      mk({ name: "Below $55,000 (Yes)", category: "crypto", ...q("Will Bitcoin trade below $55,000 at any point in 2026?") }),
    ];
    const [e] = groupMarkets(ladder, new Map());
    expect(e).toMatchObject({ type: "strike", groupedBy: "level", exh: false });
    expect(e.outcomes.map((o) => o.name)).toEqual(["↑ $119,999.99", "↑ $99,999.99", "↓ $55,000", "↓ $45,000"]);
    expect(e.outcomes[0].lv).toBe(119999.99);
  });
  it("index ranges + tails form one multi ordered by level", () => {
    const xs = [
      mk({ name: "Above 33,000 (Yes)", category: "economics", ...q("Will the Nasdaq 100 Index close above 33,000 at year-end 2026?") }),
      mk({ name: "19,000 to 19,499.99 (Yes)", category: "economics", ...q("Will the Nasdaq 100 Index close between 19,000 and 19,499.99 at year-end 2026?") }),
      mk({ name: "Below 19,000 (Yes)", category: "economics", ...q("Will the Nasdaq 100 Index close below 19,000 at year-end 2026?") }),
    ];
    const [e] = groupMarkets(xs, new Map());
    expect(e).toMatchObject({ type: "multi", groupedBy: "level", title: "Will the Nasdaq 100 Index close … at year-end 2026?" });
    expect(e.outcomes.map((o) => o.name)).toEqual(["↓ 19,000", "19,000 to 19,499.99", "↑ 33,000"]);
  });
  it("deadline ladders form a date event ordered by date", () => {
    const xs = ["Dec 31", "Oct 15", "Nov 30"].map((d) => mk({ name: "Yes (Yes)", category: "politics", ...q(`Will the US end the Iran blockade by ${d}?`) }));
    const [e] = groupMarkets(xs, new Map());
    expect(e).toMatchObject({ type: "date", groupedBy: "date" });
    expect(e.outcomes.map((o) => o.name)).toEqual(["Oct 15", "Nov 30", "Dec 31"]);
  });
  it("F1 / World Cup '<X> wins <CODE>' markets group per code", () => {
    const f1 = ["Lando Norris", "Max Verstappen"].map((s) => mk({ name: `${s} wins SG26`, description: `Resolves YES if ${s} wins Singapore Grand Prix 2026; otherwise NO.` }));
    const wc = ["ESP", "ARG"].map((s) => mk({ name: `${s} wins WC26` }));
    const events = groupMarkets([...f1, ...wc], new Map());
    expect(events.map((e) => e.title).sort()).toEqual(["WC26 winner?", "Who wins Singapore Grand Prix 2026?"]);
  });
  it("World Cup 'A vs B: X wins (YES)' markets form a match", () => {
    const xs = [mk({ name: "NOR vs ENG: ENG wins (YES)" }), mk({ name: "NOR vs ENG: NOR wins (YES)" }), mk({ name: "NOR vs ENG: Draw (YES)" })];
    const [e] = groupMarkets(xs, new Map());
    expect(e).toMatchObject({ type: "match", groupedBy: "vs", title: "NOR vs ENG" });
    expect(e.outcomes.map((o) => o.name)).toEqual(["NOR", "Draw", "ENG"]);
  });
  it("symbol roots group what the text cannot (balance of power)", () => {
    const xs = [
      mk({ name: "Democratic Senate & House (Yes)", symbol: "BOP-DD-Y", category: "politics", ...q("Will Democrats win the Senate and Democrats win the House in the 2026 midterms?") }),
      mk({ name: "Republican Senate & House (Yes)", symbol: "BOP-RR-Y", category: "politics", ...q("Will Republicans win the Senate and Republicans win the House in the 2026 midterms?") }),
    ];
    expect(groupMarkets(xs, new Map())[0]).toMatchObject({ type: "multi", groupedBy: "symbol" });
  });
  it("Up / Down windows are their own live events", () => {
    const w = mk({ name: "BTC Up", symbol: "BTC-UP", category: "crypto", startMs: 1_000, endMs: 901_000, resolutionKind: 1 });
    const [e] = groupMarkets([w], new Map());
    expect(e).toMatchObject({ type: "updown", groupedBy: "window", title: "BTC Up or Down · 15 min", asset: "BTC" });
    expect(e.outcomes[0]).toMatchObject({ yl: "Up", nl: "Down" });
  });
  it("spread / total markets naming both teams join the match as lines", () => {
    const a = mk({ name: "Barcelona (Yes)", ...q("Will Barcelona win?"), groupId: "G9" });
    const b = mk({ name: "Osasuna (Yes)", ...q("Will Osasuna win?"), groupId: "G9" });
    const line = mk({ name: "Over 2.5 (Yes)", ...q("Barcelona vs Osasuna: total goals over 2.5?") });
    const events = groupMarkets([a, b, line], new Map([["G9", [a.id, b.id]]]));
    expect(events).toHaveLength(1);
    expect(events[0].outcomes.at(-1)).toMatchObject({ grp: "lines", marketId: line.id });
  });
  it("a lone single-team market stays a binary event", () => {
    const [e] = groupMarkets([mk({ name: "Barcelona (Yes)", ...q("Will Barcelona win?") })], new Map());
    expect(e).toMatchObject({ type: "binary", title: "Will Barcelona win?" });
  });
});
