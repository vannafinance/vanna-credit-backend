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
  parseClauseFacts,
  parseMinHf,
  splitClauses,
  validateLever,
  validateRead,
  validateWrite,
  type Asset,
  type AskOption,
  type Intent,
  type ReadIntent,
  type WriteIntent,
  type WriteOp,
  type ConceptTopic,
  type ParsedClause,
} from "./intent";
import { LlmUnavailable, llmConfigured, routeWithModel } from "./vertex";

const QUESTION_OPENER = /^(?:what|what's|whats|how|which|show|list|tell|give|is|are|do|does|where|why|when|who)\b/;
const ALL_WORDS = /\b(?:all|everything|entire|full(?:y)?|max|maximum|whole|off)\b/;

const ask = (question: string, options?: AskOption[]): Intent => ({ lane: "ask", question, ...(options?.length ? { options } : {}) });
const refuse = (message: string): Intent => ({ lane: "refuse", reason: "guard", message });

const FARM_HINT = /\b(?:kamino|farm|farming|farmed|unfarm)\b/;
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
    if (ALL_WORDS.test(lower)) amount = { kind: "all" };
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

  const questionish = QUESTION_OPENER.test(lower) || lower.endsWith("?");
  const hasAmount = f.amount !== null && f.amount.kind !== "all";
  const command = !questionish || hasAmount;

  // ── strategy: leverage ──
  if ((/\b(?:lever|leverage|leveraged|loop|long)\b/.test(lower) && f.leverage) || (f.leverage && f.assets.length && /\b(?:go|get|want|make|turn|open)\b/.test(lower) && command && /\bx\b|×|times/.test(lower))) {
    const asset = f.assets[0] ?? null;
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

    // ── swap ──
    if (/\b(?:swap|convert|exchange)\b|\btrade\b.+\bfor\b/.test(lower)) {
      const order = swapAssets(lower, f);
      if (!order) return ask("Which asset do you want to swap, into which asset, and how much?");
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
    if (/\bborrow(?:ing)?\b/.test(lower) && !/\b(?:capacity|power|limit)\b/.test(lower) && !/\bhow\s+much\b/.test(lower)) return writeIntent("borrow", f, lower);
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

  if (/\b(?:earned|interest|my\s+earn|supplied|my\s+deposits?|earn\s+(?:balance|position)|lent)\b/.test(lower) && !/\b(?:apy|apr|rates?)\b/.test(lower)) {
    return read({ kind: "earn_position", assets: f.assets });
  }
  if (/\b(?:apy|apr|rates?|yields?|utili[sz]ation|pools?|available\s+liquidity)\b/.test(lower)) return read({ kind: "pool", assets: f.assets });
  if (/\b(?:owe|debts?|borrowed|loans?)\b/.test(lower)) return read({ kind: "debt" });
  if (/\bcollateral\b/.test(lower)) return read({ kind: "collateral" });
  if (/\b(?:price|prices|worth|trading\s+at|oracle)\b/.test(lower)) return read({ kind: "price", assets: f.assets });
  if (/\b(?:wallet|balances?|how\s+much\s+.*\bdo\s+i\s+have)\b/.test(lower)) return read({ kind: "wallet" });

  return { lane: "unknown" };
}

const REPORT_CLAUSE = /\b(?:tell\s+me|show\s+me|check|report|what(?:'s|\s+is)|give\s+me)\b.*\b(?:health|hf)\b/;

/** Keyword route for a whole message, including "A then B" chains. */
export function keywordRoute(message: string): Intent {
  const clauses = splitClauses(message);
  if (clauses.length <= 1) return routeClause(message);

  const steps: Array<{ write: WriteIntent } | { report: true }> = [];
  for (const c of clauses) {
    const lower = c.toLowerCase();
    if (REPORT_CLAUSE.test(lower) && !/\b(?:deposit|withdraw|borrow|repay|supply|swap|farm|redeem|lend)\b/.test(lower)) {
      steps.push({ report: true });
      continue;
    }
    const r = routeClause(c);
    if (r.lane === "write") steps.push({ write: r.write });
    else if (r.lane === "ask" || r.lane === "refuse") return r;
    else if (r.lane === "lever") return ask("A leverage strategy has to be its own request. Ask for the leverage on its own and I'll size it.");
    else return ask(`I couldn't tell what you want for "${c.slice(0, 80)}". Say each step with its asset and amount.`);
  }
  if (!steps.some((s) => "write" in s)) return routeClause(message);
  return { lane: "chain", steps };
}

export interface RouteResult {
  intent: Intent;
  source: "keyword" | "model" | "unavailable";
  tokens: number;
}

export async function routeMessage(
  message: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const keyword = keywordRoute(message);
  if (keyword.lane !== "unknown") return { intent: keyword, source: "keyword", tokens: 0 };
  if (!llmConfigured()) return { intent: keyword, source: "unavailable", tokens: 0 };
  try {
    const { intent, tokens } = await routeWithModel(message, history, signal);
    return { intent, source: "model", tokens };
  } catch (e) {
    if (!(e instanceof LlmUnavailable)) console.warn("[copilot] model routing failed:", e instanceof Error ? e.message : e);
    return { intent: keyword, source: "unavailable", tokens: 0 };
  }
}

export const PRODUCT_ASSET_LIST = [...PRODUCT_ASSETS];
