import { CAPABILITY_LINE } from "./domain-firewall";
import { getLlm, llmConfigured } from "./vertex";

/**
 * A greeting answered by the smallest model, not by the investigation (a "hi" used to cost the whole 13k-token research prompt and
 * 4-8 s). The firewall already recognises a bare greeting (`allow:greeting`); this only decides what to say.
 *
 * Narrower than the firewall's greeting: "yes", "no" and "ok" can be answers to a question the copilot just asked, so they keep going to
 * the investigation, which has the conversation. Only a greeting or thanks is social.
 *
 * Never a source of facts: the reply may not carry a number, and a model that is slow, off or says something it should not is replaced
 * by the capability line the product has always used.
 */
const SOCIAL = /^(?:hi|hello|hey|hiya|gm|good (?:morning|evening|afternoon)|thanks|thank you|thx)[\s.!?]*$/i;
const SOCIAL_BUDGET_MS = 2_500;

const SYSTEM = `You are Vanna Copilot, a DeFi assistant for a Solana margin account (lending, borrowing, swaps, farms, perps, vaults).
Reply to a greeting or a thank-you in one short, warm sentence, then say in a few words what you can help with (reading the account's health, positions and prices; preparing transactions the person approves in their wallet).
Never state any number, balance, price or account fact. No lists, no markdown, no emoji.`;

export function isSocial(message: string): boolean {
  return SOCIAL.test(message.trim());
}

export async function composeGreeting(input: { message: string; signal?: AbortSignal }): Promise<{ text: string; tokens: number; used: boolean }> {
  const fallback = { text: CAPABILITY_LINE, tokens: 0, used: false };
  if (!llmConfigured()) return fallback;
  const cap = AbortSignal.timeout(SOCIAL_BUDGET_MS);
  try {
    const res = await getLlm().generate({
      lane: "social",
      system: SYSTEM,
      user: input.message.slice(0, 80),
      maxOutputTokens: 80,
      thinkingLevel: "MINIMAL",
      signal: input.signal ? AbortSignal.any([input.signal, cap]) : cap,
    });
    const text = (res.text ?? "").trim();
    if (!text || text.length > 280 || /[0-9*_`#]/.test(text) || /^\s*[-\u2022]/m.test(text)) return { ...fallback, tokens: res.tokens };
    return { text, tokens: res.tokens, used: true };
  } catch {
    return fallback;
  }
}
