/**
 * Event grouping (pure, unit-tested in grouping.test.ts).
 *
 * World lists multi-outcome events grouped (one election event with many candidates, one match
 * with home / draw / away), while each outcome is its own binary market on chain. How markets are
 * grouped, strongest evidence first:
 *
 *   1. `window`   — a crypto Up / Down window ("BTC Up" with start / end) is its own event.
 *   2. `group`    — World's own on-chain `Group` account (mutually exclusive set: a match's
 *                   home / draw / away, every candidate of a nomination, "exactly N Fed cuts"…).
 *                   Authoritative; covers most sports games and many multi-outcome events.
 *   3. `vs`       — names like "NOR vs ENG: ENG wins (YES)" / "USA vs BIH: Draw (YES)" (World Cup
 *                   markets with no JSON metadata and no Group) → one match per pair.
 *   4. `wins`     — "<X> wins <EVENT CODE>" / "Resolves YES if X wins <event>; otherwise NO."
 *                   (F1 races and championships, World Cup winner) → one event per code.
 *   5. `level`    — the same question with a different price / rate level ("trade above $X",
 *                   "close between X and Y", "exceed X%") → a strike ladder (or a range multi).
 *   6. `date`     — the same question with a different deadline ("… by Oct 31") → a date ladder.
 *   7. `template` — the same question with a different subject ("Will {} win the 2028 Democratic
 *                   presidential nomination?", "Will {} be arrested in 2026?") → one event.
 *   8. `symbol`   — the same symbol root ("BOP-DD-Y", "BOP-RR-Y") in the same category.
 *   9. `single`   — everything else is a one-market binary event.
 * Families of rules 3–8 with a single live member fall back to `single`.
 * Side markets (spread / total) that name both teams of a match join it as `grp: "lines"`.
 */
import type { Cat, EventType, JsonMeta, MarketInfo, MintMeta } from "./types";

// -------------------------------------------------------------------------------------------------
// Classification (category / league / question) — ported from Backend-Solana-v2 catalog.server.ts
// -------------------------------------------------------------------------------------------------

const SPORTS_FOLDERS: Record<string, string> = {
  nfl: "NFL", mls: "MLS", mlb: "MLB", nba: "NBA", nhl: "NHL", epl: "EPL", lig: "La Liga", laliga: "La Liga",
  seriea: "Serie A", bundesliga: "Bundesliga", ligue1: "Ligue 1", ucl: "UCL", f1: "F1", ncaafb: "NCAAF",
  ncaaf: "NCAAF", ncaab: "NCAAB", flags: "International", tennis: "Tennis", ufc: "UFC", golf: "Golf",
};
/** Generic images World uses at `/img/<name>.png`. */
const IMAGE_FILES: Record<string, { category: Cat; league: string | null }> = {
  finance: { category: "economics", league: "Finance" },
  economics: { category: "economics", league: "Economics" },
  politics: { category: "politics", league: null },
  culture: { category: "other", league: "Culture" },
  soccer: { category: "sports", league: "Soccer" },
  ufc: { category: "sports", league: "UFC" },
  tennis: { category: "sports", league: "Tennis" },
  wimbledon: { category: "sports", league: "Tennis" },
  btc: { category: "crypto", league: "Bitcoin" },
  eth: { category: "crypto", league: "Ethereum" },
  sol: { category: "crypto", league: "Solana" },
  xrp: { category: "crypto", league: "XRP" },
  hype: { category: "crypto", league: "Hyperliquid" },
};

/** Category and league from World's metadata image path (`https://m.world.xyz/<folder>/x.png`). */
export function classify(meta: Pick<MintMeta, "name" | "symbol"> | undefined, json: JsonMeta | undefined): { category: Cat; league: string | null } {
  const image = json?.image ?? "";
  const folder = image.match(/m\.world\.xyz\/([^/]+)\/[^/]+$/)?.[1]?.toLowerCase();
  if (folder === "politics") return { category: "politics", league: null };
  if (folder && folder in SPORTS_FOLDERS) return { category: "sports", league: SPORTS_FOLDERS[folder] };
  const file = image.match(/\/([^/.]+)\.[a-z]+$/)?.[1]?.toLowerCase();
  if (file && file in IMAGE_FILES) return IMAGE_FILES[file];
  if (folder && folder !== "img") return { category: "sports", league: folder.toUpperCase() };
  // No JSON: guess from the on-chain name / symbol.
  const name = meta?.name ?? "";
  const symbol = meta?.symbol ?? "";
  if (/^(BTC|ETH|SOL|XRP|HYPE)-UP$/.test(symbol)) return { category: "crypto", league: null };
  if (/^(DN|RN|PE|HR|SEN|BOP|ARR|LEAD)-/.test(symbol) || /Democrat|Republican|nomination|President/i.test(name)) return { category: "politics", league: null };
  if (/^(CPI|GAS|NDX|SPX|FED|GDP|U3|WTI)-/.test(symbol) || /^Above |^Below /.test(name)) return { category: "economics", league: null };
  if (/ vs [A-Z]{2,4}: /.test(name) || / wins (WC|DC|CC)\d{2}$/.test(name)) return { category: "sports", league: / WC\d{2}$|: /.test(name) ? "World Cup" : "F1" };
  if (/\((Yes)\)$/.test(name) || / wins [A-Z]{2}\d{2}$/.test(name)) return { category: "sports", league: null };
  return { category: "other", league: null };
}

/** Strips World's " (Yes)" / " (YES)" suffix from an outcome mint name. */
export const outcomeSubject = (name: string) => name.replace(/\s*\((yes)\)\s*$/i, "").trim();

/** "Resolves YES if the answer to "Will Columbus win?" is yes" → "Will Columbus win?" */
export function questionFrom(meta: Pick<MintMeta, "name"> | undefined, json: JsonMeta | undefined): string {
  const quoted = json?.description?.match(/"([^"]+)"/)?.[1];
  if (quoted) return /\?$/.test(quoted) ? quoted : `${quoted}?`;
  const plain = json?.description?.match(/^Resolves YES if (.+?);\s*otherwise NO\.?$/i)?.[1];
  if (plain) return `Will ${plain}?`;
  const name = outcomeSubject(meta?.name ?? "Unknown market");
  return /\?$/.test(name) ? name : `${name}?`;
}

// -------------------------------------------------------------------------------------------------
// Family keys
// -------------------------------------------------------------------------------------------------

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE_RE = new RegExp(`\\b(by|before|through|on or before|until)\\s+(${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)`, "i");
/** A price / rate level: $1,234.56, 4.5%, $1.4 trillion, 33,000, $4.60/gal … (never a bare year). */
const NUM = String.raw`\$?\d[\d,]*(?:\.\d+)?(?:\s?(?:trillion|billion|million)\b|%|[TBMK]\b)?(?:\/gal)?`;
const LEVEL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\bbetween (${NUM}) and (${NUM})`, "i"),
  new RegExp(String.raw`\b(?:at )?(${NUM}) or (?:above|higher|more|below|lower|less)\b`, "i"),
  new RegExp(String.raw`\b(?:above|below|exceed|exceeds|over|under|more than|less than|at least|at or above|at or below|reach|hit)\s+(${NUM})`, "i"),
];

export interface LevelMatch {
  template: string;
  /** Lower bound / the level, as a number. */
  level: number;
  /** "up" = resolves YES at or above the level, "down" = at or below, "range" = between. */
  dir: "up" | "down" | "range";
  /** The level as written ("$99,999.99", "19,000 to 19,499.99"). */
  text: string;
}

const toNumber = (text: string) => {
  const m = text.replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)(%|trillion|billion|million|T|B|M|K)?/i);
  if (!m) return NaN;
  const mult: Record<string, number> = { trillion: 1e12, t: 1e12, billion: 1e9, b: 1e9, million: 1e6, m: 1e6, k: 1e3 };
  return Number(m[1]) * (m[2] && m[2] !== "%" ? (mult[m[2].toLowerCase()] ?? 1) : 1);
};

/** Replaces the level phrase of a question with `{lvl}`; null if the question has no level. */
export function levelTemplate(question: string): LevelMatch | null {
  for (const re of LEVEL_PATTERNS) {
    const m = question.match(re);
    if (!m || m.index === undefined) continue;
    const phrase = m[0];
    if (/\b(19|20)\d{2}\b/.test(m[1]) && !/[$%,.]/.test(m[1])) continue; // "over 2026" is a year
    const template = `${question.slice(0, m.index)}{lvl}${question.slice(m.index + phrase.length)}`;
    if (m[2]) return { template, level: toNumber(m[1]), dir: "range", text: `${m[1]} to ${m[2]}` };
    const down = /below|under|less|lower|at or below/i.test(phrase);
    return { template, level: toNumber(m[1]), dir: down ? "down" : "up", text: m[1].trim() };
  }
  return null;
}

/** Replaces a deadline ("by Oct 31") with `{date}`; null if none. */
export function dateTemplate(question: string): { template: string; date: string } | null {
  const m = question.match(DATE_RE);
  if (!m || m.index === undefined) return null;
  const at = m.index + m[0].length - m[2].length;
  return { template: `${question.slice(0, at)}{date}${question.slice(at + m[2].length)}`, date: m[2] };
}

/** Questions that differ only by subject: "Will {} win the 2028 … nomination?". Null when too generic. */
export function subjectTemplate(question: string, subject: string): string | null {
  if (subject.length < 2 || /^(yes|no)$/i.test(subject) || !question.includes(subject)) return null;
  const template = question.replace(subject, "{}");
  const rest = template.replace(/\{\}|\?/g, "").trim();
  // "Will {} win?" (one team of an unnamed game) or the subject alone carry no event.
  if (/^will\s+win$/i.test(rest) || rest.split(/\s+/).filter(Boolean).length < 3) return null;
  return template;
}

/** "NOR vs ENG: ENG wins (YES)" / "USA vs BIH: Draw (YES)". */
export function parseVs(name: string): { home: string; away: string; pick: string } | null {
  const m = name.match(/^([A-Za-z0-9.' ]{2,24}?) vs\.? ([A-Za-z0-9.' ]{2,24}?):\s*(.+?)(?: wins)?\s*\((?:yes)\)$/i);
  if (!m) return null;
  return { home: m[1].trim(), away: m[2].trim(), pick: m[3].trim() };
}

/** "Lando Norris wins DC26" + "Resolves YES if Lando Norris wins Formula 1 2026 Drivers' Championship". */
export function parseWins(name: string, description: string | null): { subject: string; code: string; eventName: string | null } | null {
  const byName = name.match(/^(.+?) wins ([A-Z]{2,4}\d{2})$/);
  const byDesc = description?.match(/^Resolves YES if (.+?) wins (.+?);\s*otherwise NO\.?$/i) ?? null;
  if (byName) return { subject: byName[1], code: byName[2], eventName: byDesc?.[2] ?? null };
  if (byDesc) return { subject: byDesc[1], code: byDesc[2], eventName: byDesc[2] };
  return null;
}

/** FNV-1a 32-bit, base36: short stable ids for derived families. */
export function familyId(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `f-${(h >>> 0).toString(36)}`;
}

/** Word-level common prefix / suffix of several questions, as an event title. */
export function commonTitle(questions: string[]): string {
  if (questions.length === 0) return "";
  if (questions.length === 1) return questions[0];
  const words = questions.map((q) => q.split(/\s+/));
  let pre = 0;
  while (words.every((w) => w[pre] !== undefined && w[pre] === words[0][pre])) pre++;
  let suf = 0;
  const min = Math.min(...words.map((w) => w.length));
  while (suf < min - pre && words.every((w) => w[w.length - 1 - suf] === words[0][words[0].length - 1 - suf])) suf++;
  const prefix = words[0].slice(0, pre).join(" ");
  const suffix = words[0].slice(words[0].length - suf).join(" ");
  return templateTitle(`${prefix} {} ${suffix}`.trim());
}

/** "Will {} win the 2028 … nomination?" → "Who will win the 2028 … nomination?" */
export function templateTitle(template: string): string {
  const t = template.replace(/\s+/g, " ").trim();
  const who = t.match(/^Will \{\} (.+)$/);
  if (who) return `Who will ${who[1]}`;
  return t.replace("{}", "…").replace("{lvl}", "…").replace("{date}", "…");
}

// -------------------------------------------------------------------------------------------------
// Grouping
// -------------------------------------------------------------------------------------------------

export interface OutcomeSkeleton {
  marketId: string;
  name: string;
  ab?: string;
  yl?: string;
  nl?: string;
  lv?: number;
  grp?: "lines";
}

export interface EventSkeleton {
  id: string;
  type: EventType;
  groupedBy: "group" | "vs" | "wins" | "template" | "level" | "date" | "symbol" | "single" | "window";
  title: string;
  cat: Cat;
  tag: string;
  league: string | null;
  image: string | null;
  rules: string;
  note?: string;
  exh?: boolean;
  asset?: string;
  ic: string;
  startMs: number | null;
  endMs: number | null;
  outcomes: OutcomeSkeleton[];
}

const CAT_TAG: Record<Cat, string> = { crypto: "Crypto", sports: "Sports", politics: "Politics", economics: "Economics", other: "Other" };
const DRAW = /^draw$/i;
const TIE_LEAGUES = new Set(["NFL", "NCAAF"]);

const symbolRoot = (symbol: string) => symbol.replace(/-(Y|UP)$/i, "").split("-")[0].slice(0, 5) || "?";
const teamCode = (m: MarketInfo) => symbolRoot(m.symbol.replace(/-Y$/, "")).slice(0, 4);

function majority<T>(xs: T[]): T {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function base(members: MarketInfo[]): Pick<EventSkeleton, "cat" | "tag" | "league" | "image" | "startMs" | "endMs"> {
  const cat = majority(members.map((m) => m.category));
  const league = members.map((m) => m.league).find(Boolean) ?? null;
  return {
    cat,
    league,
    tag: league ?? CAT_TAG[cat],
    image: members.map((m) => m.image).find(Boolean) ?? null,
    startMs: members.map((m) => m.startMs).find((v) => v !== null) ?? null,
    endMs: members.map((m) => m.endMs).find((v) => v !== null) ?? null,
  };
}

const rulesOf = (members: MarketInfo[], multi: boolean) => {
  const d = members.map((m) => m.description).find(Boolean) ?? members[0].question;
  return multi ? `Each outcome is its own Yes / No market. ${d}` : d;
};

const isWindow = (m: MarketInfo) => /^[A-Z0-9]+ Up$/.test(m.name) && m.startMs !== null && m.endMs !== null;

function windowEvent(m: MarketInfo): EventSkeleton {
  const asset = m.name.replace(/ Up$/, "");
  const minutes = Math.round((m.endMs! - m.startMs!) / 60_000);
  return {
    id: m.id,
    type: "updown",
    groupedBy: "window",
    title: `${asset} Up or Down · ${minutes} min`,
    ...base([m]),
    cat: "crypto",
    tag: asset,
    rules: m.description ?? `Resolves Up if ${asset}/USD closes at or above its opening price for this ${minutes}-minute window, otherwise Down.`,
    asset,
    ic: asset,
    image: m.image ?? `https://m.world.xyz/img/${asset}.png`,
    outcomes: [{ marketId: m.id, name: `${asset} ${minutes} min`, yl: "Up", nl: "Down" }],
  };
}

function singleEvent(m: MarketInfo): EventSkeleton {
  return {
    id: m.id,
    type: "binary",
    groupedBy: "single",
    title: m.question,
    ...base([m]),
    rules: rulesOf([m], false),
    ic: symbolRoot(m.symbol),
    outcomes: [{ marketId: m.id, name: m.question.replace(/\?$/, "") }],
  };
}

function groupEvent(id: string, members: MarketInfo[]): EventSkeleton {
  const b = base(members);
  const teams = members.filter((m) => !DRAW.test(outcomeSubject(m.name)));
  const hasDraw = teams.length < members.length;
  // A sports Group of at most two sides (+ an optional draw) is a game: "Will X win?" per side.
  if (b.cat === "sports" && teams.length >= 1 && teams.length <= 2 && members.length <= 3) {
    const names = teams.map((m) => outcomeSubject(m.name));
    return {
      id,
      type: "match",
      groupedBy: "group",
      title: names.length === 2 ? `${names[0]} vs ${names[1]}` : `${names[0]} match`,
      ...b,
      rules: `Each side is its own Yes / No market and exactly one can resolve YES${hasDraw ? " (draw included)" : ""}.`,
      note: "each party is its own Yes / No market",
      exh: !hasDraw && b.league && TIE_LEAGUES.has(b.league) ? false : undefined,
      ic: teamCode(teams[0]),
      outcomes: members.map((m) => ({ marketId: m.id, name: outcomeSubject(m.name), ab: DRAW.test(outcomeSubject(m.name)) ? "DRAW" : teamCode(m) })),
    };
  }
  const names = members.map((m) => outcomeSubject(m.name));
  const common = commonTitle(members.map((m) => m.question));
  // Questions without World's JSON yet ("Arsenal?") share no words: name the event by its outcomes.
  const title = /[A-Za-z]{3}/.test(common.replace(/^Who will\s*/, "")) ? common : `${b.tag}: ${names.slice(0, 2).join(" / ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
  return {
    id,
    type: "multi",
    groupedBy: "group",
    title,
    ...b,
    rules: rulesOf(members, true),
    note: "exactly one outcome resolves YES",
    ic: symbolRoot(members[0].symbol),
    outcomes: members.map((m) => ({ marketId: m.id, name: outcomeSubject(m.name) })),
  };
}

type FamilyRule = "vs" | "wins" | "level" | "date" | "template" | "symbol";
interface Candidate {
  rule: FamilyRule;
  key: string;
  outcome: OutcomeSkeleton;
  sort: number;
  meta?: { dir?: LevelMatch["dir"]; template?: string; eventName?: string | null; home?: string; away?: string };
}

/** The family a market (not in a World Group) belongs to, by the first matching rule. */
export function familyOf(m: MarketInfo): Candidate | null {
  const subject = outcomeSubject(m.name);
  const vs = parseVs(m.name);
  if (vs) {
    const pair = [vs.home, vs.away].sort().join("|");
    const draw = DRAW.test(vs.pick);
    return { rule: "vs", key: `vs:${pair}`, outcome: { marketId: m.id, name: vs.pick, ab: draw ? "DRAW" : vs.pick.slice(0, 4).toUpperCase() }, sort: draw ? 1 : vs.pick === vs.home ? 0 : 2, meta: { home: vs.home, away: vs.away } };
  }
  const wins = parseWins(m.name, m.description);
  if (wins) return { rule: "wins", key: `wins:${wins.code}`, outcome: { marketId: m.id, name: wins.subject }, sort: 0, meta: { eventName: wins.eventName } };
  const level = levelTemplate(m.question);
  if (level) {
    const name = level.dir === "range" ? level.text : `${level.dir === "up" ? "↑" : "↓"} ${level.text}`;
    return { rule: "level", key: `lvl:${level.template}`, outcome: { marketId: m.id, name, lv: level.level }, sort: level.level, meta: { dir: level.dir, template: level.template } };
  }
  const date = dateTemplate(m.question);
  if (date) {
    const t = Date.parse(`${date.date}${/\d{4}/.test(date.date) ? "" : `, ${new Date().getUTCFullYear()}`}`);
    return { rule: "date", key: `date:${date.template}`, outcome: { marketId: m.id, name: date.date }, sort: Number.isFinite(t) ? t : 0, meta: { template: date.template } };
  }
  const tpl = subjectTemplate(m.question, subject);
  if (tpl) return { rule: "template", key: `tpl:${tpl}`, outcome: { marketId: m.id, name: subject }, sort: 0, meta: { template: tpl } };
  const sym = m.symbol.match(/^([A-Z][A-Z0-9]{1,5})-([A-Z0-9]{2,6})-Y$/);
  if (sym) return { rule: "symbol", key: `sym:${sym[1]}|${m.category}`, outcome: { marketId: m.id, name: subject }, sort: 0 };
  return null;
}

function familyEvent(rule: FamilyRule, key: string, members: MarketInfo[], cands: Candidate[]): EventSkeleton {
  const b = base(members);
  const order = cands.map((c, i) => ({ c, m: members[i] }));
  const id = familyId(key);
  const common = { id, ...b, ic: symbolRoot(members[0].symbol), groupedBy: rule } as const;
  switch (rule) {
    case "vs": {
      order.sort((a, z) => a.c.sort - z.c.sort);
      const { home, away } = cands[0].meta!;
      return { ...common, type: "match", title: `${home} vs ${away}`, cat: "sports", tag: b.league ?? "World Cup", rules: `Each side is its own Yes / No market: "${members[0].name}" and its siblings.`, note: "each party is its own Yes / No market", ic: home!.slice(0, 4), outcomes: order.map((x) => x.c.outcome) };
    }
    case "wins": {
      const eventName = cands.map((c) => c.meta?.eventName).find(Boolean);
      const code = key.slice(5);
      return { ...common, type: "multi", title: eventName ? `Who wins ${eventName}?` : `${code} winner?`, rules: rulesOf(members, true), note: "each outcome is its own Yes / No market", ic: code.slice(0, 4), outcomes: order.map((x) => x.c.outcome) };
    }
    case "level": {
      const range = cands.some((c) => c.meta?.dir === "range");
      // Ranges: by level; a "below X" tail sorts before the range starting at X, "above" after.
      const dirRank = (c: Candidate) => (c.meta?.dir === "down" ? 0 : c.meta?.dir === "range" ? 1 : 2);
      if (range) order.sort((a, z) => a.c.sort - z.c.sort || dirRank(a.c) - dirRank(z.c));
      else order.sort((a, z) => (a.c.meta?.dir === z.c.meta?.dir ? z.c.sort - a.c.sort : a.c.meta?.dir === "up" ? -1 : 1));
      return { ...common, type: range ? "multi" : "strike", title: templateTitle(cands[0].meta!.template!), rules: rulesOf(members, true), note: range ? "exactly one range resolves YES" : "each target is its own Yes / No market", exh: range ? undefined : false, outcomes: order.map((x) => x.c.outcome) };
    }
    case "date":
      order.sort((a, z) => a.c.sort - z.c.sort);
      return { ...common, type: "date", title: templateTitle(cands[0].meta!.template!), rules: rulesOf(members, true), note: "a later date includes the earlier ones", exh: false, outcomes: order.map((x) => x.c.outcome) };
    case "template": {
      const template = cands[0].meta!.template!;
      const exclusive = /\bwin\b/i.test(template);
      return { ...common, type: "multi", title: templateTitle(template), rules: rulesOf(members, true), note: exclusive ? "exactly one outcome resolves YES" : "each outcome is its own Yes / No market", exh: exclusive ? undefined : false, outcomes: order.map((x) => x.c.outcome) };
    }
    case "symbol":
      return { ...common, type: "multi", title: commonTitle(members.map((m) => m.question)), rules: rulesOf(members, true), note: "each outcome is its own Yes / No market", exh: false, outcomes: order.map((x) => x.c.outcome) };
  }
}

const LINES_RE = /\b(spread|total|over\/under|o\/u|handicap)\b/i;

/**
 * Groups markets into events. `groups` maps a World Group id to its member market ids (in the
 * group's own order); markets missing from `markets` are skipped. Returns events in input order of
 * their first member.
 */
export function groupMarkets(markets: MarketInfo[], groups: Map<string, string[]>): EventSkeleton[] {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const events: EventSkeleton[] = [];
  const used = new Set<string>();

  for (const m of markets) {
    if (used.has(m.id)) continue;
    if (isWindow(m)) {
      used.add(m.id);
      events.push(windowEvent(m));
      continue;
    }
    if (m.groupId) {
      const members = (groups.get(m.groupId) ?? [m.id]).map((id) => byId.get(id)).filter((x): x is MarketInfo => Boolean(x) && !used.has(x!.id));
      members.forEach((x) => used.add(x.id));
      events.push(members.length === 1 && !DRAW.test(outcomeSubject(members[0].name)) ? singleEvent(members[0]) : groupEvent(m.groupId, members));
    }
  }

  const families = new Map<string, { rule: FamilyRule; members: MarketInfo[]; cands: Candidate[] }>();
  const singles: MarketInfo[] = [];
  for (const m of markets) {
    if (used.has(m.id)) continue;
    const c = familyOf(m);
    if (!c) {
      singles.push(m);
      continue;
    }
    const f = families.get(c.key) ?? { rule: c.rule, members: [], cands: [] };
    f.members.push(m);
    f.cands.push(c);
    families.set(c.key, f);
  }
  for (const [key, f] of families) {
    if (f.members.length < 2) singles.push(...f.members);
    else events.push(familyEvent(f.rule, key, f.members, f.cands));
  }

  // Side markets (spread / total) naming both teams of a match join that match as "lines".
  const matches = events.filter((e) => e.type === "match");
  for (const m of singles) {
    if (LINES_RE.test(m.question)) {
      const match = matches.find((e) => {
        const teams = e.outcomes.filter((o) => o.ab !== "DRAW").map((o) => o.name);
        return teams.length === 2 && teams.every((t) => m.question.includes(t));
      });
      if (match) {
        match.outcomes.push({ marketId: m.id, name: outcomeSubject(m.name), grp: "lines" });
        continue;
      }
    }
    events.push(singleEvent(m));
  }
  return events;
}
