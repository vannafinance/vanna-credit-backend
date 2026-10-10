/**
 * Router: a message -> an Intent.
 *
 * 1. Keyword router (deterministic, free). Handles every phrase in the product's prompt library.
 * 2. Gemini function calling (`routeWithModel`) only when the keyword router finds nothing.
 *
 * Both routes end in the same guards (`validate*` in intent.ts), so the choice of router cannot
 * change what is allowed. A missing detail becomes a question, never a default.
 */

import {
  LEND_BORROW_ASSETS,
  PRODUCT_ASSETS,
  normalizeAsset,
  parseAmountToken,
  parseClauseFacts,
  parseMinHf,
  splitClauses,
  typedNumbers,
  validateLever,
  validateRead,
  validateWrite,
  unofferedMessage,
  perpMarketOf,
  vaultOf,
  extractAssets,
  type Asset,
  type AskOption,
  type Intent,
  type ReadIntent,
  type ChainStep,
  type WriteIntent,
  type WriteOp,
  type ConceptTopic,
  type ParsedClause,
} from "./intent";
import { CONDITIONAL_BASE_MESSAGE, detectConditional, immediateRemainder } from "./conditional";
import { LlmUnavailable, llmConfigured, routeWithModel } from "./vertex";

/** "when" opens a question only as "when is / will / does ..."; "when SOL drops below 100, sell" is an order. */
const QUESTION_OPENER = /^(?:what|what's|whats|how|which|show|list|tell|give|is|are|do|does|where|why|when(?=\s+(?:is|was|are|were|do|does|did|will|would|can|could|should)\b)|who)\b/;
/** A polite or first-person request is still a command even though it is phrased as a question. */
const POLITE = /^(?:(?:can|could|would|will)\s+you|please|pls|i\s+(?:want|wanna|would\s+like|need)\s+to|let'?s|go\s+ahead)\b/;
/** "can I ...", "what if ...", "without getting liquidated": a question about an outcome, never an order. */
const HYPOTHETICAL = /\b(?:can\s+i|could\s+i|am\s+i\s+able|is\s+it\s+(?:safe|ok|okay|possible|fine)|would\s+it\s+be|what\s+(?:if|happens|will|would)|if\s+i\b|how\s+(?:much|many)\b.*\b(?:need|can|could|should|to)\b|without\s+(?:getting\s+)?liquidat\w*|will\s+i\s+be\s+liquidat\w*)\b/;
const RATE_QUESTION = /\b(?:rates?|apys?|aprs?|interest|yields?)\b/;
const ACTION_VERB = /\b(?:supply|lend|deposit|withdraw|borrow|repay|pay\s+back|swap|convert|exchange|redeem|farm|unfarm|quote|trade|lever|leverage)\b/;
const WRITE_VERB = /\b(?:supply|lend|deposit|withdraw|borrow|repay|pay\s+back|pay\s+off|swap|convert|exchange|redeem|farm|unfarm|buy|sell|lever|leverage|open|close)\b/;
const ALL_WORDS = /\b(?:all|everything|entire|full(?:y)?|max|maximum|whole|off)\b/;

const ask = (question: string, options?: AskOption[]): Intent => ({ lane: "ask", question, ...(options?.length ? { options } : {}) });
const refuse = (message: string): Intent => ({ lane: "refuse", reason: "guard", message });

const FARM_HINT = /\b(?:kamino|farm|farming|farmed|unfarm)\b/;
/** A perps message phrased as a question or a preview reads; anything else with a trade verb trades. */
/** A request for yield that names no product: "best yield", "where should I put my USDC", "passive income". */
const YIELD_ASK = /\b(?:best|highest|top|better|compare|comparison|options?|where\s+(?:should|can|do)\s+i|ways?\s+to)\b[^.?!]*\b(?:yield|apy|apr|returns?|interest|earn(?:ing)?|income)\b|\b(?:passive\s+income|put\s+(?:it|my\s+\w+|them)\s+to\s+work|grow\s+my\s+\w+|stake\s+my\s+\w+|best\s+place\s+(?:for|to\s+put)\s+my\s+\w+|earn\s+(?:on|with|from)\s+my\s+\w+)\b/;
/** A product named in the message: then it is not a generic yield question. */
const PRODUCT_NAMED = /\b(?:earn\s+pool|lending\s+pool|kamino|farm|vaults?|basis|perena|junior|delta[\s-]?neutral)\b|usd\*/;
/** Basis / Perena vaults: "vault", "basis", "delta neutral", "perena", "USD*", "junior", the vb share tickers. */
const VAULT_HINT = /\b(?:vaults?|basis|delta[\s-]?neutral|perena|junior|vb(?:sol|eth|btc|tsla|meta))\b|usd\*/;
const PERP_QUESTION = /\b(?:what\s+(?:if|would|happens|are|is)|preview|simulate|look\s+like|how\s+(?:much|many|close|far)|would\s+(?:it|a|an|my|i)|show|list|tell\s+me|which|can\s+i|could\s+i)\b|\?\s*$/;
/** Phoenix perps: "perp", "perps", "perpetuals", "SOL-PERP", "phoenix". */
const PERP_HINT = /\b(?:perps?|perpetuals?|phoenix)\b|\b(?:sol|eth|btc|tsla|meta)-?perp\b/;
const MARGIN_HINT = /\b(?:collateral|margin)\b/;
const EARN_HINT = /\b(?:earn|pool|vault|lending|vtokens?)\b/;
const LIQUIDATION_READ = /\bliquidat\w*\b/;

function concept(lower: string): ConceptTopic | null {
  if (!/\b(?:what\s+(?:is|are|does|'s)|what's|explain|how\s+does|how\s+do|meaning\s+of|define)\b/.test(lower)) return null;
  if (/\b(?:my|mine)\b/.test(lower) && !/\bwhat\s+is\s+(?:a|an|the)\b/.test(lower)) return null;
  // "what are the kamino apys" asks for data about a venue, not what the venue is.
  if (/\b(?:apys?|aprs?|rates?|positions?|prices?|balances?|markets?|history|debt|owe)\b/.test(lower)) return null;
  if (/\bhealth\s*factor\b|\bhf\b/.test(lower)) return "health_factor";
  if (/\bliquidat\w*/.test(lower)) return "liquidation";
  if (/\bleverag\w*|\blever\b/.test(lower)) return "leverage";
  if (/\bcollateral\b/.test(lower)) return "collateral";
  if (/\bearn\b/.test(lower)) return "earn";
  if (/\b(?:farm|kamino)\b/.test(lower)) return "farm";
  if (/\bmargin\b/.test(lower)) return "margin";
  return null;
}

function amountOrAsk(f: ParsedClause, verb: string, asset: Asset | null): { amount: WriteIntent["amount"]; question?: string } {
  if (f.amount) return { amount: f.amount };
  return { amount: null, question: `How much${asset ? ` ${asset}` : ""} do you want to ${verb}?` };
}

function writeIntent(op: WriteOp, f: ParsedClause, lower: string, extra: Partial<WriteIntent> = {}): Intent {
  const asset = extra.asset !== undefined ? extra.asset : (f.assets[0] ?? null);
  const verbText: Partial<Record<WriteOp, string>> = {
    earn_supply: "supply",
    earn_redeem: "redeem",
    deposit: "deposit",
    withdraw: "withdraw",
    borrow: "borrow",
    repay: "repay",
    swap: "swap",
    farm_deposit: "farm",
    farm_redeem: "redeem",
  };
  const needsAsset = op !== "create_account" && op !== "close_account";
  if (needsAsset && !asset) {
    const many: AskOption[] = LEND_BORROW_ASSETS.map((a) => ({ label: a, apply: { lane: "write", write: { op, asset: a, amount: f.amount, ...(extra.source ? { source: extra.source } : {}) } } as Intent }));
    const opts = f.amount && (op === "borrow" || op === "repay" || op === "earn_supply") ? many : undefined;
    return ask(`Which asset do you want to ${verbText[op] ?? "use"}?`, opts);
  }
  let amount = f.amount;
  if (needsAsset && !amount) {
    // "borrow SOL 3x": no amount, but a leverage target. The server sizes it from live prices (index.ts), never a typed number.
    if (op === "borrow" && f.leverage) amount = { kind: "lev", multiple: f.leverage };
    else if (ALL_WORDS.test(lower)) amount = { kind: "all" };
    else if (op === "farm_redeem" && f.receipts.length) amount = { kind: "all" };
    else return ask(amountOrAsk(f, verbText[op] ?? "use", asset).question as string);
  }
  const w: WriteIntent = { op, asset, amount: needsAsset ? amount : null, ...extra };
  const v = validateWrite(w);
  return v.ok ? { lane: "write", write: v.value } : refuse(v.message);
}

function ambiguousVenue(verb: "deposit" | "withdraw", f: ParsedClause): Intent {
  const asset = f.assets[0] ?? null;
  const mk = (op: WriteOp): Intent => ({ lane: "write", write: { op, asset, amount: f.amount } });
  const q = `Do you want to ${verb} ${f.amount && asset ? "that " : ""}${asset ?? "it"} ${verb === "deposit" ? "into" : "from"}...`;
  if (!asset || !f.amount) return ask(`Which asset and how much do you want to ${verb}, and where: the Vanna Earn pool, your margin account, or Kamino farm?`);
  const earnOp: WriteOp = verb === "deposit" ? "earn_supply" : "earn_redeem";
  const marginOp: WriteOp = verb === "deposit" ? "deposit" : "withdraw";
  const farmOp: WriteOp = verb === "deposit" ? "farm_deposit" : "farm_redeem";
  const options: AskOption[] = [];
  if ((LEND_BORROW_ASSETS as readonly string[]).includes(asset)) options.push({ label: "Vanna Earn pool", description: verb === "deposit" ? "Earn the pool's supply rate; not collateral." : "Take funds back out of the pool.", apply: mk(earnOp) });
  options.push({ label: "Margin account", description: verb === "deposit" ? "Add as collateral to borrow against." : "Take collateral out of your margin account.", apply: mk(marginOp) });
  options.push({ label: "Kamino farm", description: verb === "deposit" ? "Supply from your margin balance to Kamino." : "Redeem your Kamino position back to margin.", apply: mk(farmOp) });
  return ask(q, options);
}

const DAYS = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
/** Conditions and schedules the Copilot cannot watch or run later. */
const DEFERRED: RegExp[] = [
  /\b(?:every|each)\s+(?:day|week|month|hour|night|morning|\d+\s*(?:min(?:ute)?s?|hours?|days?|weeks?)|weekday)\b/,
  /\b(?:daily|weekly|monthly|hourly|recurring|dca|dollar[- ]cost)\b/,
  new RegExp("\\b(?:tomorrow|tonight|later(?:\\s+today)?|next\\s+(?:week|month|" + DAYS + ")|on\\s+" + DAYS + "|in\\s+\\d+\\s*(?:min(?:ute)?s?|hours?|days?|weeks?)|after\\s+\\d+\\s*(?:min(?:ute)?s?|hours?|days?)|at\\s+(?:noon|midnight)|by\\s+(?:tomorrow|tonight|friday|monday|the\\s+weekend))\\b"),
  /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/,
  /\bat\s+\d{1,2}:\d{2}\b/,
  /\b(?:limit\s+order|stop[- ]?loss|take[- ]?profit|trailing\s+stop|buy\s+the\s+dip)\b/,
  /\b(?:auto[- ]?compound\w*|auto[- ]?rebalanc\w*|rebalanc\w*|automatic(?:ally)?|autopilot)\b/,
  /\b(?:when|once|if|as\s+soon\s+as|whenever|until)\b[^,.;]*\b(?:price|hits?|reach(?:es)?|drops?|falls?|rises?|above|below|under|over|crosses?|goes|gets)\b/,
  /\b(?:at|@)\s*\$?\d+(?:\.\d+)?\s*(?:usd|usdc|dollars?|\$)?\s*$/,
];

/** The clause with the first deferred span removed (the "do it now" version); null when the clause is not conditional. */
function deferredSpan(lower: string): string | null {
  if (!WRITE_VERB.test(lower) && !/\b(?:limit\s+order|stop[- ]?loss|take[- ]?profit|trailing\s+stop|dca|dollar[- ]cost|auto[- ]?compound\w*|auto[- ]?rebalanc\w*|rebalanc\w*|automatic(?:ally)?|autopilot)\b/.test(lower)) return null;
  for (const re of DEFERRED) {
    const m = lower.match(re);
    if (m && m.index !== undefined) {
      return (lower.slice(0, m.index) + " " + lower.slice(m.index + m[0].length)).replace(/\s+/g, " ").replace(/\s+([,.;?])/g, "$1").trim();
    }
  }
  return null;
}

function deferredRefusal(nowVersion: string): Intent {
  const clean = nowVersion.replace(/[,.;\s]+$/, "");
  const offer = clean.length > 3 && WRITE_VERB.test(clean) ?` If you want it now, tell me: "${clean}" and I will prepare it for your approval.` : "";
  return refuse(`I can't watch prices or act at a later time, so I won't set that up; I only prepare actions you approve right now.${offer}`);
}

/**
 * A conditional, scheduled or standing order in an instruction ("top up if HF < 1.2", "auto-compound every hour") is
 * refused before any model call, with the product's own wording and an offer to do the immediate part now. A question
 * about a condition ("what happens if SOL drops 20%?") is not an order and passes.
 */
export function conditionalRefusal(message: string): string | null {
  const raw = message.trim();
  const lower = raw.toLowerCase().replace(/[’`]/g, "'");
  if (!lower) return null;
  const questionish = QUESTION_OPENER.test(lower) || lower.endsWith("?") || HYPOTHETICAL.test(lower);
  if (questionish && !POLITE.test(lower)) return null;
  const cond = detectConditional(raw);
  if (cond) {
    const rest = immediateRemainder(raw, cond);
    const offer = rest.length > 3 && WRITE_VERB.test(rest.toLowerCase()) ? ` If you want it now, tell me: "${rest}" and I will prepare it for your approval.` : "";
    return `${CONDITIONAL_BASE_MESSAGE}${offer}`;
  }
  const now = deferredSpan(lower);
  if (now !== null) {
    const r = deferredRefusal(now);
    return r.lane === "refuse" ? r.message : null;
  }
  return null;
}

/** The asset named closest to `at`, so "how many USDC can I borrow" picks USDC, not another asset in the sentence. */
function assetNear(lower: string, assets: Asset[], at: number): Asset | null {
  let best: { a: Asset; d: number } | null = null;
  for (const a of assets) {
    for (const m of lower.matchAll(new RegExp("\\b" + a.toLowerCase() + "\\b", "g"))) {
      const d = Math.abs((m.index ?? 0) - at);
      if (!best || d < best.d) best = { a, d };
    }
  }
  return best ? best.a : null;
}

/** "can I borrow 500 USDC", "what if I withdraw 1 SOL", "how much to repay to get HF 2": a question about an outcome. */
function routeWhatIf(lower: string, f: ParsedClause): Intent | null {
  const verb = lower.match(/\b(borrow(?:ing)?|withdraw|take\s+out|repay|pay\s+back|pay\s+off)\b/);
  if (!verb) return null;
  const op: "borrow" | "withdraw" | "repay" = /borrow/.test(verb[1]) ? "borrow" : /withdraw|take/.test(verb[1]) ? "withdraw" : "repay";
  const at = verb.index ?? 0;
  const asset = assetNear(lower, f.assets, at);
  const tgt = lower.match(/\b(?:hf|health(?:\s*factor)?)\b(?:\s*(?:of|at|above|over|to|stays?|least|min(?:imum)?|>=|>|≥|=))*\s*(\d+(?:\.\d+)?)/);
  const targetHf = tgt ? Number(tgt[1]) : null;
  // Only a number right after the verb is the amount asked about; "I have 3 SOL" is context.
  const after = lower.slice(at + verb[0].length).match(/^\s*(?:up\s+to\s+|about\s+|around\s+)?([-+]?[\d.,]+(?:e[-+]?\d+)?k?)/);
  let amount: string | null = null;
  if (after) {
    const r = parseAmountToken(after[1], { allowExponent: true });
    if (!r.ok) return r.issue.kind === "ambiguous" ? ask(r.issue.message) : refuse(r.issue.message);
    amount = r.value;
  }
  if (amount === null && targetHf === null) return null;
  if (!asset) return ask(`Which asset do you want to check ${op === "borrow" ? "borrowing" : op === "withdraw" ? "withdrawing" : "repaying"}?`);
  const v = validateRead({ kind: "whatif", op, asset, amount, target_hf: amount !== null ? null : targetHf });
  return v.ok ? { lane: "read", read: v.value } : refuse(v.message);
}

/** One clause that may be a command, a question, or a strategy. */
export function routeClause(clause: string): Intent {
  const raw = clause.trim();
  const lower = raw.toLowerCase().replace(/[’`]/g, "'");
  if (!lower) return { lane: "unknown" };
  const f = parseClauseFacts(raw);

  if (/^(?:hi|hello|hey|gm|help|examples?|options)\b[!.?\s]*$/.test(lower) || /\bwhat\s+can\s+(?:you|i)\s+(?:do|ask|try)\b|\bwho\s+are\s+you\b|\bwhat\s+are\s+you\b|\b(?:your|you)\s+(?:capabilities|features|commands)\b|\bhow\s+do\s+i\s+(?:use|start)\b|\bgetting\s+started\b/.test(lower)) {
    return { lane: "read", read: { kind: "help" } };
  }

  const topic = concept(lower);
  if (topic && !f.amount) return { lane: "read", read: { kind: "concept", topic } };

  const questionish = QUESTION_OPENER.test(lower) || lower.endsWith("?") || HYPOTHETICAL.test(lower);
  const polite = POLITE.test(lower);
  // A question stays a question even with a number in it; only a polite request or a bare imperative is an order.
  const command = !questionish || polite;

  // Conditions and schedules cannot be watched; refuse before anything is built.
  if (command) {
    // The broad multilingual detector first; the simpler English one stays as a second net.
    const cond = detectConditional(raw);
    if (cond) {
      const rest = immediateRemainder(raw, cond);
      const offer = rest.length > 3 && WRITE_VERB.test(rest.toLowerCase()) ? ` If you want it now, tell me: "${rest}" and I will prepare it for your approval.` : "";
      return refuse(`${CONDITIONAL_BASE_MESSAGE}${offer}`);
    }
    const now = deferredSpan(lower);
    if (now !== null) return deferredRefusal(now);
  }

  // A number that cannot be used exactly as typed (negative, zero, 1e-3, 1.000,5, two different amounts) stops here.
  if (f.amountIssue && ACTION_VERB.test(lower)) return f.amountIssue.kind === "ambiguous" ? ask(f.amountIssue.message) : refuse(f.amountIssue.message);

  // Hypotheticals ("can I borrow 500 USDC?", "what if I withdraw 1 SOL?") are answered from the MCP, never previewed.
  if (questionish && !polite) {
    const w = routeWhatIf(lower, f);
    if (w) return w;
  }


  // ── strategy: unwind / close everything ──
  const unwind = unwindIntent(lower);
  if (unwind && command) return { lane: "unwind", unwind };

  // ── strategy: leverage ──
  if ((/\b(?:lever|leverage|leveraged|loop|long)\b/.test(lower) && f.leverage) || (f.leverage && f.assets.length && /\b(?:go|get|want|make|turn|open)\b/.test(lower) && command && /\bx\b|×|times/.test(lower))) {
    // "borrow USDC with 3x leverage against my JupSOL": the stable being borrowed is the funding, not the asset to lever.
    const named = lower.match(BORROW_STABLE)?.[1]?.toUpperCase() as "USDC" | "USDT" | undefined;
    const asset = (named ? f.assets.find((a) => a !== named) : null) ?? f.assets[0] ?? null;
    if (!asset) return ask("Which asset do you want to lever?", LEND_BORROW_ASSETS.map((a) => ({ label: a, apply: { lane: "lever", lever: { asset: a, leverage: f.leverage as number, borrow_asset: null, amount: null } } as Intent })));
    const borrow = f.assets.find((a) => a === "USDC" || a === "USDT") && f.assets.length > 1 && /\b(?:borrow(?:ing)?|against|funded|using|with|via)\b/.test(lower) ? (f.assets.find((a) => a !== asset && (a === "USDC" || a === "USDT")) as "USDC" | "USDT" | undefined) ?? null : null;
    const minHf = parseMinHf(lower);
    const amountText = f.amount && f.amount.kind === "exact" ? f.amount.value : null;
    const v = validateLever({ asset, leverage: f.leverage, borrow_asset: borrow ?? null, amount: amountText, min_hf: minHf });
    return v.ok ? { lane: "lever", lever: v.value } : refuse(v.message);
  }

  if (command || /\b(?:open|create|close)\b/.test(lower)) {
    // ── account lifecycle ──
    if (/\bclose\b/.test(lower) && /\baccount\b/.test(lower)) return writeIntent("close_account", f, lower);
    if (/\b(?:open|create|set\s*up|make|start)\b/.test(lower) && /\baccount\b/.test(lower)) return writeIntent("create_account", f, lower);

    // ── swap sized by what you receive: "swap SOL to get 100 USDC", "buy 100 USDC with SOL" ──
    const xo = exactOutSwap(lower, f);
    if (xo && /\b(?:swap|convert|exchange|trade|buy|sell(?:ing)?|using|with)\b/.test(lower)) {
      const source = /\b(?:margin|collateral|inside|in my account)\b/.test(lower) ? "margin" : "wallet";
      return writeIntent("swap", f, lower, { asset: xo.from, to_asset: xo.to, source, amount: { kind: "out", value: xo.value } });
    }

    // ── swap ──
    if (/\b(?:swap|convert|exchange)\b|\btrade\b.+\bfor\b/.test(lower)) {
      const order = swapAssets(lower, f);
      if (!order) {
        // "swap 5 SOL to SOL": one asset named on both sides is a different problem from a missing one.
        const named = f.assets.length === 1 ? f.assets[0] : null;
        const twice = named ? (lower.match(new RegExp(`\\b${named.toLowerCase()}\\b`, "g")) ?? []).length >= 2 : false;
        if (twice && /\b(?:to|for|into)\b/.test(lower)) return refuse("Pick two different assets to swap.");
        return ask("Which asset do you want to swap, into which asset, and how much?");
      }
      const source = /\b(?:margin|collateral|inside|in my account)\b/.test(lower) ? "margin" : "wallet";
      return writeIntent("swap", f, lower, { asset: order.from, to_asset: order.to, source });
    }

    // ── farm (Kamino) ──
    const receiptOnly = f.receipts.length > 0 && f.assets.length === 0;
    if (/\b(?:redeem|withdraw|unfarm|exit|pull|unstake|take)\b/.test(lower) && (FARM_HINT.test(lower) || receiptOnly)) {
      return writeIntent("farm_redeem", f, lower, { asset: f.receipts[0] ?? f.assets[0] ?? null });
    }
    if (FARM_HINT.test(lower) && /\b(?:farm|deposit|supply|put|stake|add|invest|lend)\b/.test(lower) && !/\b(?:apy|apr|rates?|markets?|positions?)\b/.test(lower)) {
      return writeIntent("farm_deposit", f, lower);
    }

    // ── debt ──
    if (/\bborrow(?:ing)?\b/.test(lower) && !/\b(?:capacity|power|limit)\b/.test(lower) && !/\bhow\s+much\b/.test(lower) && !RATE_QUESTION.test(lower)) return writeIntent("borrow", f, lower);
    if (/\b(?:repay|pay\s+back|pay\s+off|payoff)\b/.test(lower)) {
      const source = /\b(?:from|with|using)\s+(?:my\s+)?(?:margin|collateral)\b/.test(lower) ? "margin" : "wallet";
      return writeIntent("repay", f, lower, { source });
    }

    // ── earn / margin collateral ──
    if (/\b(?:supply|lend|invest|unlend)\b/.test(lower) && !/\b(?:apy|apr|rates?)\b/.test(lower)) {
      if (/\bunlend\b/.test(lower)) return writeIntent("earn_redeem", f, lower);
      return writeIntent("earn_supply", f, lower);
    }
    if (/\bredeem\b/.test(lower)) return writeIntent("earn_redeem", f, lower);
    if (/\bdeposit\b|\badd\s+collateral\b|\bpost\s+collateral\b|\bput\s+up\b/.test(lower)) {
      if (MARGIN_HINT.test(lower)) return writeIntent("deposit", f, lower);
      if (EARN_HINT.test(lower)) return writeIntent("earn_supply", f, lower);
      return ambiguousVenue("deposit", f);
    }
    if (/\bwithdraw\b|\bremove\s+collateral\b|\btake\s+out\b/.test(lower)) {
      if (MARGIN_HINT.test(lower)) return writeIntent("withdraw", f, lower);
      if (EARN_HINT.test(lower)) return writeIntent("earn_redeem", f, lower);
      return ambiguousVenue("withdraw", f);
    }
  }

  return routeRead(lower, f);
}

/** Well-known coins that are not Vanna product assets (a price question about one is answered with a refusal). */
const OTHER_COIN =
  /\b(?:bitcoin|btc|wbtc|ethereum|ether|eth|weth|dogecoin|doge|bonk|pepe|shib|shiba|xrp|ripple|cardano|ada|bnb|matic|polygon|avax|avalanche|dot|polkadot|ltc|litecoin|trx|tron|ton|sui|apt|aptos|arb|op|jup|ray|wif|pyth|jto|msol|bsol|usde|dai|pyusd)\b/;

/** "close everything", "unwind my positions", "exit all my positions", "close out my margin positions". */
const UNWIND =
  /\b(?:unwind|wind\s+down|close\s+(?:out\s+)?(?:everything|all\b|(?:all\s+)?(?:of\s+)?my\s+(?:\w+\s+)?positions?)|exit\s+(?:everything|all\b|(?:all\s+)?(?:of\s+)?my\s+(?:\w+\s+)?positions?)|get\s+out\s+of\s+everything|pull\s+everything\s+out)\b/;

function unwindIntent(lower: string): import("./intent").UnwindIntent | null {
  if (!UNWIND.test(lower)) return null;
  const scope = /\bearn\b/.test(lower) && !/\b(?:margin|kamino|farm|debt)\b/.test(lower)
    ? "earn"
    : /\b(?:kamino|farm)\b/.test(lower) && !/\b(?:margin|earn|debt)\b/.test(lower)
      ? "farm"
      : /\b(?:margin|debt|leverage|lever|borrow(?:ing|s)?)\b/.test(lower) && !/\bearn\b/.test(lower)
        ? "margin"
        : "all";
  return { scope, close_account: /\baccount\b/.test(lower) && /\bclose\b/.test(lower) };
}

/** The amount names what is RECEIVED: "get 100 USDC", "receive at least 2 SOL", "buy exactly 50 USDT". */
const EXACT_OUT = /\b(?:get|receive|end\s+up\s+with|buy)\s+(?:exactly\s+|at\s+least\s+|precisely\s+|about\s+)?(\d[\d.,]*k?)\s*([a-z][a-z0-9]*)\b/i;

function exactOutSwap(lower: string, f: ParsedClause): { from: Asset; to: Asset; value: string } | null {
  const m = lower.match(EXACT_OUT);
  if (!m) return null;
  const to = normalizeAsset(m[2]);
  if (!to) return null;
  const amount = parseAmountToken(m[1]);
  if (!amount.ok) return null;
  const from = f.assets.find((a) => a !== to) ?? null;
  return from ? { from, to, value: amount.value } : null;
}

function swapAssets(lower: string, f: ParsedClause): { from: Asset; to: Asset } | null {
  if (f.assets.length < 2) return null;
  // "swap A to B" / "swap A for B": order of appearance. "buy B with A" is not supported (a plain buy is ambiguous).
  const idxTo = lower.search(/\b(?:to|for|into)\b/);
  const positions = f.assets.map((a) => ({ a, i: lower.indexOf(a.toLowerCase()) })).sort((x, y) => x.i - y.i);
  if (idxTo >= 0) {
    const before = positions.filter((p) => p.i < idxTo);
    const after = positions.filter((p) => p.i > idxTo);
    if (before.length && after.length) return { from: before[0].a, to: after[0].a };
  }
  return { from: positions[0].a, to: positions[1].a };
}

function routeRead(lower: string, f: ParsedClause): Intent {
  const read = (r: ReadIntent): Intent => {
    const v = validateRead(r);
    return v.ok ? { lane: "read", read: v.value } : refuse(v.message);
  };

  if (LIQUIDATION_READ.test(lower)) return read({ kind: "liquidation_risk" });

  if (/\bhow\s+much\b.*\b(?:can|could|may)\s+i\b.*\b(?:borrow|withdraw|take\s+out)\b|\b(?:max(?:imum)?|safe|available)\b.*\b(?:borrow|withdraw)\b|\bborrowing\s+(?:capacity|power|limit)\b|\b(?:borrow|withdraw)able\b|\bheadroom\b/.test(lower)) {
    const what = /\bwithdraw|take\s+out/.test(lower) ? "withdraw" : "borrow";
    return read({ kind: "capacity", what, asset: f.assets[0] ?? null });
  }

  if (/\bquote\b/.test(lower) || (/\bhow\s+much\b.*\b(?:get|receive)\b/.test(lower) && f.assets.length >= 2)) {
    const order = swapAssets(lower, f);
    if (!order || !f.amount || f.amount.kind !== "exact") return ask("Which assets and how much would you like a swap quote for?");
    return read({ kind: "quote", from: order.from, to: order.to, amount: f.amount.value });
  }

  if (/\bhealth\s*factor\b|\bhf\b|\bhealth\b|\bam\s+i\s+(?:safe|ok|okay|healthy)\b/.test(lower)) return read({ kind: "health" });
  if (FARM_HINT.test(lower)) {
    if (/\b(?:my|mine|i\s+have|do\s+i)\b/.test(lower)) return read({ kind: "farm_positions" });
    return read({ kind: "farm_markets" });
  }
  if (/\b(?:positions?|portfolio|holdings?|net\s+(?:worth|value)|overview|summary|everything\s+i\s+have|what\s+do\s+i\s+have)\b/.test(lower)) return read({ kind: "positions" });
  if (/\b(?:history|transactions?|activity|recent)\b/.test(lower)) return read({ kind: "history" });
  if (/\b(?:protocol|addresses|supported\s+assets|which\s+assets|what\s+assets|integrations?|operating\s+mode)\b/.test(lower)) return read({ kind: "protocol" });

  if (/\b(?:earned|interest|my\s+earn|supplied|my\s+deposits?|earn\s+(?:balance|position)|lent)\b/.test(lower) && !/\b(?:apy|apr|rates?)\b/.test(lower) && !/\bborrow\w*\b/.test(lower)) {
    return read({ kind: "earn_position", assets: f.assets });
  }
  if (/\b(?:apy|apr|rates?|yields?|utili[sz]ation|pools?|available\s+liquidity)\b|\bborrow\w*\s+interest\b|\binterest\s+rates?\b/.test(lower)) return read({ kind: "pool", assets: f.assets });
  if (/\b(?:owe|debts?|borrowed|loans?)\b/.test(lower)) return read({ kind: "debt" });
  if (/\bcollateral\b/.test(lower)) return read({ kind: "collateral" });
  if (/\b(?:price|prices|worth|trading\s+at|oracle)\b/.test(lower)) {
    // "price of Bitcoin" names a coin outside the product: say so instead of listing every product price.
    const foreign = f.assets.length ? null : (lower.match(OTHER_COIN)?.[0] ?? f.unknownTokens[0] ?? null);
    if (foreign) return refuse(unofferedMessage(foreign.length <= 5 ? foreign.toUpperCase() : foreign.replace(/^./, (c) => c.toUpperCase())));
    return read({ kind: "price", assets: f.assets });
  }
  if (/\b(?:wallet|balances?|how\s+much\s+.*\bdo\s+i\s+have)\b/.test(lower)) return read({ kind: "wallet" });

  return { lane: "unknown" };
}

const REPORT_CLAUSE = /\b(?:tell\s+me|show\s+me|check|report|what(?:'s|\s+is)|give\s+me)\b.*\b(?:health|hf)\b/;

/** "borrow 20 USDC" / "borrowing USDT": the stable named right after a borrow verb. */
const BORROW_STABLE = /\bborrow(?:ing)?\s+(?:some\s+|\d[\d.,]*\s*)?(usdc|usdt)\b/i;
const LEVER_WORD = /\b(?:lever|leverage|leveraged|loop|long)\b/;
/** Verbs that make a message a real multi-step plan, which a leverage request cannot be mixed into. */
const OTHER_WRITE_VERB = /\b(?:supply|lend|swap|convert|exchange|trade|farm|redeem|repay|withdraw|unlend|open|close)\b/;

/**
 * "Deposit 1 JupSOL and borrow USDC with 3x leverage" is one leverage request, not a chain: the lever plan
 * itself deposits the asset, borrows the stable and swaps it back in. Rewrite it to the form the lever route
 * already understands ("lever 1 JupSOL 3x borrowing USDC"). Anything with other steps in it is left alone.
 */
function mergeDepositLever(message: string, clauses: string[]): string | null {
  const lower = message.toLowerCase();
  if (!LEVER_WORD.test(lower) || OTHER_WRITE_VERB.test(lower)) return null;
  const whole = parseClauseFacts(message);
  if (!whole.leverage) return null;
  const deposits = clauses.filter((c) => /\bdeposit\b/i.test(c));
  if (deposits.length !== 1) return null;
  const d = parseClauseFacts(deposits[0]);
  const asset = d.assets[0];
  if (!asset || d.assets.length !== 1) return null;
  const amount = d.amount && d.amount.kind === "exact" ? d.amount.value : null;
  const stable = lower.match(BORROW_STABLE)?.[1]?.toUpperCase() ?? null;
  const minHf = parseMinHf(lower);
  return ["lever", amount, asset, `${whole.leverage}x`, stable ? `borrowing ${stable}` : null, minHf ? `keeping health factor above ${minHf}` : null]
    .filter(Boolean)
    .join(" ");
}

/** A later step that works on the margin account makes a bare "deposit" in the same message mean margin collateral. */
const MARGIN_FLOW = /\b(?:borrow|repay|lever|leverage|withdraw|collateral|margin)\b/;
const VENUE_WORDS = /\b(?:collateral|margin|earn|pool|vault|lending|kamino|farm)\b/;
/** "swap it", "deposit that", "the proceeds": the amount and asset of the step before. */
const PRONOUN = /\b(?:it|that|them|those|the\s+(?:proceeds|borrowed(?:\s+\w+)?|funds|money|usdc|usdt|sol))\b/i;

function fromPrevious(clause: string, prev: WriteIntent | null): string | null {
  if (!prev || !prev.asset || !PRONOUN.test(clause)) return null;
  if (!["borrow", "withdraw", "earn_redeem", "farm_redeem"].includes(prev.op)) return null;
  if (!prev.amount || prev.amount.kind !== "exact") return null;
  if (parseClauseFacts(clause).amount) return null; // the clause names its own amount
  return clause.replace(PRONOUN, `${prev.amount.value} ${prev.asset}`);
}

const LIST_VERB = /^\s*(?:(?:please|pls)\s+|(?:can|could|would)\s+you\s+|i\s+(?:want|wanna|would\s+like|need)\s+to\s+|i'd\s+like\s+to\s+)?(deposit|supply|lend|withdraw|borrow|repay|redeem)\b/i;

/**
 * "deposit 100 USDC, 100 USDT and 1 SOL in the lending pool": one verb over a list of amount+asset pairs is one step per
 * pair, each keeping what follows the list ("in the lending pool"). Only a plain list qualifies: if anything after it
 * is another action, the sentence is left to the normal clause splitter (and to the model).
 */
export function expandAmountList(message: string): string[] | null {
  const head = message.match(LIST_VERB);
  if (!head) return null;
  const verb = head[1].toLowerCase();
  const rest = message.slice(head[0].length);
  const pair = /\s*(\d[\d.,]*k?)\s*([a-z][a-z0-9]*)/iy;
  const sep = /\s*(?:,|&|\+|\band\b)\s*/iy;
  const pairs: string[] = [];
  let at = 0;
  let committed = 0;
  for (;;) {
    pair.lastIndex = at;
    const m = pair.exec(rest);
    if (!m || !normalizeAsset(m[2])) break;
    pairs.push(`${m[1]} ${m[2]}`);
    committed = pair.lastIndex;
    sep.lastIndex = committed;
    const s = sep.exec(rest);
    if (!s) break;
    at = sep.lastIndex;
  }
  if (pairs.length < 2) return null;
  const suffix = rest.slice(committed);
  if (/\b(?:then|and|also|after|before)\b|[;]/i.test(suffix) && ACTION_VERB.test(suffix.toLowerCase())) return null;
  return pairs.map((p) => `${verb} ${p}${suffix}`.replace(/\s+/g, " ").trim());
}

/** Keyword route for a whole message, including "A then B" chains. */
/**
 * Phoenix perps reads, checked before anything else: "long SOL 3x with 50 USDC" reads as spot leverage on its own, but
 * with "perp" in the message it is a perps question. (Trading perps is answered by the domain firewall first.)
 */
function perpsRead(lower: string): Intent | null {
  if (!PERP_HINT.test(lower)) return null;
  const read = (r: ReadIntent): Intent => {
    const v = validateRead(r);
    return v.ok ? { lane: "read", read: v.value } : refuse(v.message);
  };
  const write = (w: WriteIntent): Intent => {
    const v = validateWrite(w);
    return v.ok ? { lane: "write", write: v.value } : ask(v.message);
  };
  const market = perpMarketOf((lower.match(/\b(sol|eth|btc|tsla|meta)(?:-?perp)?\b/) ?? [])[1]);
  const side = /\blong\b/.test(lower) ? "long" : /\bshort\b/.test(lower) ? "short" : null;
  const lev = lower.match(/(\d+(?:\.\d+)?)\s*x\b/);
  const collateral = lower.match(/(\d+(?:\.\d+)?)\s*usdc\b/);
  // A question or a preview reads; an instruction trades (this is the fallback when Gemini is unavailable).
  const question = PERP_QUESTION.test(lower);
  if (!question && /\b(?:close|exit)\b/.test(lower)) {
    const pct = /\bhalf\b/.test(lower) ? 50 : Number((lower.match(/(\d+(?:\.\d+)?)\s*%/) ?? [])[1] ?? NaN);
    return write({ op: "perp_close", asset: null, market, amount: Number.isFinite(pct) && pct < 100 ? { kind: "pct", pct } : { kind: "all" } });
  }
  if (!question && /\bwithdraw\b/.test(lower)) {
    return write({ op: "perp_withdraw", asset: null, amount: collateral ? { kind: "exact", value: collateral[1]! } : { kind: "all" } });
  }
  if (!question && side && /\b(?:open|go|long|short|buy|sell|enter|place)\b/.test(lower)) {
    return write({ op: "perp_open", asset: null, market, side, leverage: lev ? Number(lev[1]) : null, amount: collateral ? { kind: "exact", value: collateral[1]! } : null });
  }
  if (market && side && lev && collateral) {
    return read({ kind: "perps_preview", market, side, collateral: collateral[1]!, leverage: Number(lev[1]) });
  }
  if (/\b(?:my|mine|i\s+have|do\s+i|open)\b/.test(lower)) return read({ kind: "perps_positions" });
  return read({ kind: "perps_markets" });
}

/** The vault a message names: "ETH basis", "basis eth", "vbETH", "USD* junior", "USD*", "perena". */
function vaultIn(lower: string): ReturnType<typeof vaultOf> {
  const basis = lower.match(/\b(sol|eth|btc|tsla|meta)\s+basis\b|\bbasis\s+(sol|eth|btc|tsla|meta)\b|\bvb(sol|eth|btc|tsla|meta)\b/);
  if (basis) return vaultOf(`basis-${basis[1] ?? basis[2] ?? basis[3]}`);
  if (/\bjunior\b/.test(lower)) return "perena-junior";
  if (/usd\*|\bperena\b|\busdstar\b/.test(lower)) return "perena-usdstar";
  return null;
}

/**
 * Basis and Perena vaults (the keyword fallback when Gemini is unavailable): a question or a preview reads; an
 * instruction ("deposit 20 USDC into ETH basis", "withdraw my USD*") trades.
 */
function vaultsRead(lower: string): Intent | null {
  // "Kamino vault" is the Kamino farm.
  if (!VAULT_HINT.test(lower) || /\bkamino\b/.test(lower)) return null;
  const read = (r: ReadIntent): Intent => {
    const v = validateRead(r);
    return v.ok ? { lane: "read", read: v.value } : refuse(v.message);
  };
  const write = (w: WriteIntent): Intent => {
    const v = validateWrite(w);
    return v.ok ? { lane: "write", write: v.value } : ask(v.message);
  };
  const vault = vaultIn(lower);
  const amount = (lower.match(/(\d+(?:\.\d+)?)/) ?? [])[1] ?? null;
  const question = PERP_QUESTION.test(lower);
  const withdrawing = /\b(?:withdraw|exit|redeem|take\s+out|pull\s+out|cash\s+out)\b/.test(lower);
  if (!question && /\bmove\b.*\bshares?\b/.test(lower)) return write({ op: "vault_move_shares", asset: null, vault, amount: { kind: "all" } });
  if (!question && withdrawing) {
    const pct = /\bhalf\b/.test(lower) ? 50 : Number((lower.match(/(\d+(?:\.\d+)?)\s*%/) ?? [])[1] ?? NaN);
    const spec = Number.isFinite(pct) && pct < 100 ? { kind: "pct" as const, pct } : amount && !/\ball\b/.test(lower) ? { kind: "exact" as const, value: amount } : { kind: "all" as const };
    return write({ op: "vault_withdraw", asset: null, vault, amount: spec });
  }
  if (!question && /\b(?:deposit|put|add|invest|supply|enter)\b/.test(lower)) {
    return write({ op: "vault_deposit", asset: null, vault, amount: amount ? { kind: "exact", value: amount } : null });
  }
  if (vault && amount && /\b(?:preview|simulate|would|if)\b/.test(lower)) {
    return read({ kind: "vault_preview", vault, call: withdrawing ? "withdraw" : "deposit", amount });
  }
  if (/\b(?:my|mine|i\s+have|do\s+i|positions?|holdings?)\b/.test(lower)) return read({ kind: "vaults_positions" });
  return read({ kind: "vaults_list" });
}

/** "Where should I put my USDC for yield?": every way to earn on it, side by side (the user then picks). */
function yieldRead(lower: string): Intent | null {
  if (!YIELD_ASK.test(lower) || PRODUCT_NAMED.test(lower)) return null;
  const asset = extractAssets(lower).assets[0] ?? null;
  const r: ReadIntent = { kind: "yield_options", asset };
  const v = validateRead(r);
  return v.ok ? { lane: "read", read: v.value } : refuse(v.message);
}

export function keywordRoute(message: string): Intent {
  const yieldAsk = yieldRead(message.toLowerCase());
  if (yieldAsk) return yieldAsk;
  const vaults = vaultsRead(message.toLowerCase());
  if (vaults) return vaults;
  const perps = perpsRead(message.toLowerCase());
  if (perps) return perps;
  const clauses = expandAmountList(message) ?? splitClauses(message);
  if (clauses.length <= 1) return routeClause(message);

  // "Close everything and unwind my positions" is one exit request, not a chain of clauses.
  if (UNWIND.test(message.toLowerCase())) {
    const whole = routeClause(message);
    if (whole.lane === "unwind" || whole.lane === "refuse") return whole;
  }

  const asLever = mergeDepositLever(message, clauses);
  if (asLever) return routeClause(asLever);

  const marginFlow = clauses.some((c) => MARGIN_FLOW.test(c.toLowerCase()));
  const steps: ChainStep[] = [];
  // A step that needs a choice ("deposit where?") must not drop the rest of the plan when answered.
  let pending: { index: number; question: string; options: AskOption[] } | null = null;
  let prev: WriteIntent | null = null;
  for (const c of clauses) {
    const lower = c.toLowerCase();
    if (REPORT_CLAUSE.test(lower) && !/\b(?:deposit|withdraw|borrow|repay|supply|swap|farm|redeem|lend)\b/.test(lower)) {
      steps.push({ report: true });
      continue;
    }
    let text = c;
    const carried = fromPrevious(c, prev);
    if (carried) text = carried;
    else if (marginFlow && /\bdeposit\b/.test(lower) && !VENUE_WORDS.test(lower)) text = `${c} as collateral`;
    const r = routeClause(text);
    if (r.lane === "write") {
      steps.push({ write: r.write });
      prev = r.write;
    } else if (r.lane === "ask" && r.options?.length && pending === null && r.options.every((o) => o.apply.lane === "write")) {
      pending = { index: steps.length, question: r.question, options: r.options };
      steps.push({ report: true }); // placeholder, replaced by the chosen option below
    } else if (r.lane === "ask" || r.lane === "refuse") return r;
    else if (r.lane === "lever") return ask("A leverage strategy has to be its own request. Ask for the leverage on its own and I'll size it.");
    else return ask(`I couldn't tell what you want for "${c.slice(0, 80)}". Say each step with its asset and amount.`);
  }
  if (pending) {
    const at = pending.index;
    const options: AskOption[] = pending.options.map((o) => {
      const next = steps.slice();
      next[at] = { write: (o.apply as Extract<Intent, { lane: "write" }>).write };
      return { ...o, apply: { lane: "chain", steps: next } as Intent };
    });
    return ask(`${pending.question} (I'll then carry on with the rest of your steps.)`, options);
  }
  if (!steps.some((s) => "write" in s)) return routeClause(message);
  return { lane: "chain", steps };
}

export interface RouteResult {
  intent: Intent;
  source: "keyword" | "model" | "unavailable";
  tokens: number;
}

/**
 * A model-read intent may carry only amounts the user typed (in this message or an earlier message of theirs).
 * The model understands the sentence; it never supplies a number. A "leverage" multiple on a borrow is not an
 * amount (the server sizes it), so it is not checked here.
 */
export function amountsAreTyped(intent: Intent, message: string, history: Array<{ role: "user" | "assistant"; text: string }> = [], alsoTyped: number[] = []): boolean {
  // `alsoTyped`: amounts the user wrote in words, which the model read and which appear verbatim in their message.
  const typed = [...[message, ...history.filter((h) => h.role === "user").map((h) => h.text)].flatMap(typedNumbers), ...alsoTyped];
  const typedAs = (v: string) => {
    const n = Number(v);
    return typed.some((t) => Math.abs(t - n) <= 1e-9 * Math.max(1, Math.abs(n)));
  };
  const amountOk = (a: WriteIntent["amount"] | undefined) => {
    if (!a) return true;
    if (a.kind === "exact" || a.kind === "out" || a.kind === "usd") return typedAs(a.value);
    if (a.kind === "hf") return typedAs(String(a.target));
    if (a.kind === "lev" && a.base) return typedAs(a.base.value);
    return true;
  };
  switch (intent.lane) {
    case "write":
      return amountOk(intent.write.amount);
    case "chain":
      return intent.steps.every((s) => !("write" in s) || amountOk(s.write.amount));
    case "lever":
      return !intent.lever.amount || typedAs(intent.lever.amount);
    case "read":
      return intent.read.kind !== "quote" || typedAs(intent.read.amount);
    default:
      return true;
  }
}

/** The keyword router is trusted when it resolved the request or refused it. A question it asked only because
 * its patterns could not read the sentence (an amount list, a missing amount in a chain) is given to the model. */
const INFO_READS = new Set(["price", "pool", "earn_position", "farm_markets", "farm_positions", "positions", "wallet", "debt", "collateral", "history", "protocol", "perps_markets", "perps_positions", "perps_preview", "vaults_list", "vaults_positions", "vault_preview", "yield_options"]);
const AMOUNT_OF_ASSET = /\d[\d.,]*k?\s*(?:sol|usdc|usdt|jitosol|jupsol|ksol|kusdc|kusdt)\b/i;

/**
 * An imperative sentence full of amounts that the patterns read as an information request ("put 100 USDC plus 100 USDT
 * into the pool" read as "pool rates") is a verb the patterns do not know, not a question. Those go to the model too.
 */
function looksLikeUnrecognisedAction(i: Intent, message: string): boolean {
  if (i.lane !== "read" || !INFO_READS.has(i.read.kind)) return false;
  const lower = message.trim().toLowerCase();
  return AMOUNT_OF_ASSET.test(message) && !lower.includes("?") && !QUESTION_OPENER.test(lower) && !HYPOTHETICAL.test(lower);
}

const keywordIsConfident = (i: Intent, message: string): boolean =>
  i.lane !== "unknown" && !(i.lane === "ask" && !i.options?.length) && !looksLikeUnrecognisedAction(i, message);

export async function routeMessage(
  message: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const keyword = keywordRoute(message);
  if (keywordIsConfident(keyword, message)) return { intent: keyword, source: "keyword", tokens: 0 };
  if (!llmConfigured()) return { intent: keyword, source: keyword.lane === "unknown" ? "unavailable" : "keyword", tokens: 0 };
  try {
    const { intent, tokens } = await routeWithModel(message, history, signal);
    // The model may fill in what the patterns could not; it may not override a refusal, add an amount, or turn a
    // question into silence. Anything it cannot ground falls back to the keyword router's own answer.
    if (intent.lane === "unknown" || intent.lane === "refuse" || !amountsAreTyped(intent, message, history)) {
      return keyword.lane === "unknown" ? { intent: intent.lane === "refuse" ? intent : { lane: "unknown" }, source: "model", tokens } : { intent: keyword, source: "keyword", tokens };
    }
    if (intent.lane === "ask" && keyword.lane === "ask") return { intent: keyword, source: "keyword", tokens };
    return { intent, source: "model", tokens };
  } catch (e) {
    if (!(e instanceof LlmUnavailable)) console.warn("[copilot] model routing failed:", e instanceof Error ? e.message : e);
    return { intent: keyword, source: keyword.lane === "unknown" ? "unavailable" : "keyword", tokens: 0 };
  }
}

export const PRODUCT_ASSET_LIST = [...PRODUCT_ASSETS];
