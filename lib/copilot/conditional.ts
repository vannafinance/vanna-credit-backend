/**
 * Conditional, scheduled and recurring requests ("when SOL hits 90", "every week", "at 5pm", "limit
 * order", "stop loss", "DCA", "until ...").
 *
 * The Copilot acts only on what you ask right now: it cannot watch prices or wake up later, and it
 * holds no standing orders. Such a request used to lose its condition and become an immediate
 * action. This detector runs BEFORE routing, deterministically, so it can never be turned into a
 * preview or a workflow. Hypothetical questions ("what if SOL hits 90?") are reads, not orders.
 *
 * Ported idea: the Stellar Copilot's detectAutomationGap. Solana-native vocabulary, light
 * multilingual cover (Spanish, French, German, romanised Hindi).
 */

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const re = (src: string) => new RegExp(src, "iu");

const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun";

/** Forms that are an order or schedule whatever else the sentence says. */
const STRONG: RegExp[] = [
  re(`${L}(?:limit\\s+(?:order|buy|sell|swap)s?|stop[\\s-]?loss|take[\\s-]?profit|trailing\\s+stop|dca|dollar[\\s-]cost(?:\\s+averag\\w*)?|stop[\\s-]?limit)${R}`),
  re(`${L}every\\s+(?:\\d+\\s*)?(?:seconds?|minutes?|mins?|hours?|days?|weeks?|months?|years?|morning|evening|night|${DAYS})${R}`),
  re(`${L}(?:daily|weekly|monthly|hourly|nightly|recurring|repeatedly|periodically|regularly|on\\s+a\\s+schedule|each\\s+(?:day|week|month|hour))${R}`),
  re(`${L}(?:auto[\\s-]?compound\\w*|automatically|auto[\\s-]?(?:repay|rebalance|borrow|supply|swap|top[\\s-]?up)\\w*)${R}`),
  re(`${L}(?:at\\s+all\\s+times|round\\s+the\\s+clock|whenever)${R}`),
  // light multilingual: cada dia/semana, chaque jour, jeden tag, har din, todos los dias
  re(`${L}(?:cada\\s+(?:d[ií]a|semana|mes|hora)|todos\\s+los\\s+d[ií]as|chaque\\s+(?:jour|semaine|mois|heure)|jede[nrs]?\\s+(?:tag|woche|monat|stunde)|har\\s+(?:din|hafte|mahine))${R}`),
];

/** Time words that only matter next to an action. */
const TIME: RegExp[] = [
  re(`${L}at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)${R}`),
  re(`${L}\\d{1,2}\\s*(?:am|pm)${R}`),
  re(`${L}at\\s+\\d{1,2}:\\d{2}${R}`),
  re(`${L}at\\s+(?:midnight|noon|dawn|dusk)${R}`),
  re(`${L}(?:tomorrow|tonight|later\\s+(?:today|this\\s+\\w+)|this\\s+(?:evening|afternoon|weekend)|next\\s+(?:week|month|year|hour|${DAYS})|end\\s+of\\s+(?:the\\s+)?(?:day|week|month))${R}`),
  re(`${L}(?:on|by|this|before|after)\\s+(?:${DAYS})${R}`),
  re(`${L}(?:in|after|within)\\s+(?:an?|\\d+)\\s*(?:seconds?|minutes?|mins?|hours?|days?|weeks?|months?)${R}`),
  re(`${L}(?:until|till|unless)${R}`),
  re(`${L}(?:ma[ñn]ana|demain|morgen|ma[ñn]ana por la|kal)${R}`),
  re(`${L}(?:lunes|martes|lundi|mardi|montag|dienstag)${R}`),
];

const METRIC = "price|prices|sol|usdc|usdt|jitosol|jupsol|hf|health|health\\s+factor|apy|apr|rate|rates|utili[sz]ation|liquidity|tvl|market|it|they";
const TRIGGER_VERB = "hits?|hit|reach(?:es)?|drops?|dropped|falls?|fell|goes|go|gets?|becomes?|is|are|was|rises?|crosses?|exceeds?|moves?|dips?|pumps?|dumps?|crash(?:es)?|trades?|above|below|under|over|less\\s+than|more\\s+than|at\\s+least";

const CONDITION: RegExp[] = [
  // "when the price hits 90", "if SOL drops below 100", "once HF goes under 1.3"
  re(`${L}(?:when|once|as\\s+soon\\s+as|if|in\\s+case|provided|should)\\s+(?:the\\s+|my\\s+|its\\s+)?(?:${METRIC})(?:\\s+\\w+){0,4}?\\s+(?:${TRIGGER_VERB})${R}`),
  re(`${L}(?:when|once|if)\\s+[^.?!]{0,40}?(?:<=|>=|<|>|≤|≥)\\s*\\$?\\d`),
  re(`${L}(?:if|when)\\s+(?:i\\s+)?(?:get|am|become|got)\\s+liquidated${R}`),
  re(`${L}(?:cuando|quand|wenn|jab)\\s+(?:el\\s+|le\\s+|der\\s+)?(?:precio|prix|preis|price|sol)${R}`),
  // "supply 1 SOL at 90" / "swap 1 SOL to USDC at 200": a bare price after "at"
  re(`${L}at\\s+(?:a\\s+price\\s+of\\s+|price\\s+)?[$€]\\s*\\d[\\d,]*(?:\\.\\d+)?${R}`),
  re(`${L}at\\s+(?:a\\s+price\\s+of\\s+|price\\s+)?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:usd|usdc|usdt|dollars?|bucks)${R}`),
];

/** "at 200" with no unit counts as a price only for trade-like verbs and never right after hf/apy/rate words. */
const BARE_PRICE_AT = re(`${L}at\\s+(\\d[\\d,]*(?:\\.\\d+)?)(?!\\s*(?:%|x|×|am|pm|:|hf))${R}`);
const NOT_PRICE_CONTEXT = re(`(?:hf|health(?:\\s*factor)?|factor|apy|apr|rate|leverage|slippage|ltv)\\s*(?:of|at|=|:)?\\s*$`);
const TRADE_VERB = re(`${L}(?:swap|sell|buy|convert|exchange|trade|supply|lend|deposit|borrow|redeem|withdraw|repay|farm|lever|short|long|close|open|top\\s*up|move|rebalance)${R}`);

const ACTION = re(
  `${L}(?:swap|sell|buy|convert|exchange|trade|supply|lend|deposit|borrow|redeem|withdraw|repay|farm|lever|rebalance|top\\s*up|move|compound|alert|notify|remind|message|email|ping|watch|monitor|keep|protect|stay|maintain|close|open|reimburse|compensate)${R}`,
);

/** A genuine information question or what-if: a read, never an order. */
const INFO_QUESTION = re(
  `^\\s*(?:so\\s+)?(?:what\\s+(?:if|happens|would\\s+happen|will\\s+happen|is|are|was|were|does|do)|how\\s+(?:much|many|would|will|does|do|is|are|long|soon|often)|why|when\\s+(?:is|was|do|does|did|will|would)|which|who|where|is\\s+there|are\\s+there|does\\s+(?:the|it|vanna)|do\\s+you\\s+(?:support|offer|have)|can\\s+you\\s+(?:explain|tell|show)|explain|tell\\s+me\\s+(?:about|what|how)|show\\s+me\\s+(?:my|the))`,
);
/** Instructions even when they start like a question word ("how about you supply ... every week"). */
const IMPERATIVE_AFTER_Q = re(`${L}(?:please\\s+)?(?:set\\s+up|schedule|create|place|make)\\s+(?:a|an|my)?\\s*(?:\\w+\\s+){0,2}(?:order|schedule|recurring|alert|rule|automation)`);

export type Conditional = { kind: "price" | "time" | "recurring" | "limit_order" | "standing" | "unknown"; phrase: string };

/** Returns the conditional/scheduled phrase when the message asks for something later or standing. */
export function detectConditional(message: string): Conditional | null {
  const m = (message ?? "").replace(/[’`]/g, "'").trim();
  if (!m) return null;
  const info = INFO_QUESTION.test(m) && !IMPERATIVE_AFTER_Q.test(m);

  for (const r of STRONG) {
    const x = r.exec(m);
    if (!x) continue;
    if (info) continue;
    const phrase = x[0].toLowerCase();
    const kind = /limit|stop|take|dca|dollar|trailing/.test(phrase) ? "limit_order" : /every|daily|weekly|monthly|hourly|nightly|recurring|each|cada|chaque|jede|har|todos|schedule|regular|period|repeat/.test(phrase) ? "recurring" : "standing";
    return { kind, phrase };
  }
  if (info) return null;

  const acts = ACTION.test(m);
  for (const r of CONDITION) {
    const x = r.exec(m);
    if (x && (acts || /^\s*(?:if|when|once)\b/i.test(m))) return { kind: "price", phrase: x[0].toLowerCase() };
  }
  if (acts && TRADE_VERB.test(m)) {
    const x = BARE_PRICE_AT.exec(m);
    if (x && !NOT_PRICE_CONTEXT.test(m.slice(0, x.index).toLowerCase())) return { kind: "price", phrase: x[0].toLowerCase() };
  }
  if (acts) {
    for (const r of TIME) {
      const x = r.exec(m);
      if (x) return { kind: "time", phrase: x[0].toLowerCase() };
    }
  }
  return null;
}

/** Removes the conditional phrase and everything after a condition word so the remaining action can be named. */
export function immediateRemainder(message: string, c: Conditional): string {
  let t = message.replace(/[’`]/g, "'");
  const cut = t.search(re(`${L}(?:when|once|as\\s+soon\\s+as|if|every|each|until|till|unless|whenever|at\\s+(?:\\$|\\d)|tomorrow|tonight|next\\s+\\w+|on\\s+(?:${DAYS})|in\\s+(?:an?|\\d+)\\s*\\w+|daily|weekly|monthly|hourly)${R}`));
  if (cut > 0) t = t.slice(0, cut);
  // The condition comes first ("when SOL drops below 100, sell 1 SOL"): the action is what follows it.
  else if (cut === 0) t = t.includes(",") ? t.slice(t.indexOf(",") + 1) : "";
  t = t.replace(re(`${L}(?:set\\s+(?:up\\s+)?an?\\s+(?:limit\\s+order|stop[\\s-]?loss|order)\\s+(?:to|for)|place\\s+an?\\s+(?:limit\\s+)?order\\s+(?:to|for)|schedule(?:\\s+(?:a|an))?|automatically|auto[\\s-]?\\w*|please)${R}`), " ");
  void c;
  return t.replace(/[\s,;:-]+$/g, "").replace(/\s{2,}/g, " ").trim();
}

export const CONDITIONAL_BASE_MESSAGE =
  "I can't watch prices or act later: I only act on what you ask right now, and I don't keep standing, scheduled or conditional orders.";
