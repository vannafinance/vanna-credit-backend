import { PRODUCT_ASSETS, type ReadIntent } from "./intent";

/**
 * Exact-match reads that skip the investigation loop (the Stellar copilot has the same: investigation/fast-path.ts).
 *
 * EXCEPTION to "the model understands": this is a pattern match, kept deliberately tiny and exact. It exists because the two most
 * common questions, "what is my health factor?", "price of SOL" and "how much can I borrow?", do not need a model to read the question or to word the
 * answer: the figure comes from the same live read the investigation would end up making, and the code-built answer is what the
 * keyword router has always shown. A 27k-token, 7-10 s turn becomes one read.
 *
 * It matches a WHOLE message, nothing more. Anything with another clause, a condition ("if SOL drops 30%"), an amount, a second
 * asset, or any word outside the pattern falls through to the investigation unchanged, so this can never turn a request for an
 * action or a hypothetical into a plain read.
 */

const TAIL = /[\s?.!]+$/;
const FILLER = /^(?:please\s+|pls\s+|hey\s+|hi\s+)+/;

const HEALTH =
  /^(?:(?:what(?:'s|s| is| are)|show(?: me)?|check|tell me|give me)\s+)?(?:my\s+|the\s+)?(?:margin\s+(?:account\s+)?)?(?:health(?:\s*factor)?|hf)$/;
const PRICE_OF =
  /^(?:(?:what(?:'s|s| is)|show(?: me)?|check|tell me|give me)\s+)?(?:the\s+)?(?:current\s+|live\s+)?price\s+of\s+([a-z0-9]{2,10})$/;
const ASSET_PRICE = /^([a-z0-9]{2,10})\s+price$/;
/** "how much can I borrow" with no asset named: the answer is the safe amount for every borrowable asset, which the code already sizes. */
const BORROW_CAPACITY =
  /^(?:(?:how much|what(?:'s|s| is| are| can))\s+(?:can|could|may|should)?\s*i\s+(?:safely\s+)?borrow|(?:what(?:'s|s| is))\s+my\s+(?:max(?:imum)?\s+)?(?:borrow(?:ing)?\s+(?:capacity|limit|power)|max\s+borrow)|(?:my\s+)?(?:max(?:imum)?\s+borrow|borrow(?:ing)?\s+(?:capacity|limit|power)))$/;

const normalize = (message: string): string => message.trim().toLowerCase().replace(TAIL, "").replace(FILLER, "").replace(/\s+/g, " ");

export function matchFastRead(message: string): ReadIntent | null {
  const text = normalize(message);
  if (!text || text.length > 60) return null;
  if (HEALTH.test(text)) return { kind: "health" };
  if (BORROW_CAPACITY.test(text.replace(/\s+/g, " "))) return { kind: "capacity", what: "borrow", asset: null };
  const named = PRICE_OF.exec(text)?.[1] ?? ASSET_PRICE.exec(text)?.[1];
  if (named) {
    const asset = PRODUCT_ASSETS.find((a) => a.toLowerCase() === named);
    // A coin the product does not list is not answered here: the investigation says so in the product's words.
    if (asset) return { kind: "price", assets: [asset] };
  }
  return null;
}
