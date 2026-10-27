import { afterEach, describe, expect, it } from "vitest";
import { composeGreeting, isSocial } from "../social";
import { setLlmClient, type LlmClient, type LlmRequest } from "../vertex";
import { CAPABILITY_LINE } from "../domain-firewall";

afterEach(() => setLlmClient(null));

const client = (handler: (req: LlmRequest) => string | null | Error): LlmClient & { requests: LlmRequest[] } => {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async generate(req) {
      requests.push(req);
      const out = handler(req);
      if (out instanceof Error) throw out;
      return { text: out, calls: [], tokens: 40 };
    },
  };
};

describe("greeting lane", () => {
  it.each(["hi", "Hello!", "hey", "gm", "good morning", "thanks", "Thank you.", "thx"])("a greeting or thanks is social: %s", (m) => {
    expect(isSocial(m)).toBe(true);
  });

  it.each(["yes", "no", "ok", "okay", "hi, what is my health factor", "hello there, supply 5 USDC", "thanks, now borrow"])("an answer or a request is not social: %s", (m) => {
    expect(isSocial(m)).toBe(false);
  });

  it("uses the social lane at minimal thinking and returns its sentence", async () => {
    const llm = client(() => "Hi! I can read your account and prepare transactions you approve in your wallet.");
    setLlmClient(llm);
    const out = await composeGreeting({ message: "hi" });
    expect(out).toMatchObject({ used: true, tokens: 40 });
    expect(llm.requests[0]).toMatchObject({ lane: "social", thinkingLevel: "MINIMAL" });
    expect(llm.requests[0].tools).toBeUndefined();
  });

  it.each([
    ["a number", "Hi! Your health factor is 7.28."],
    ["markdown", "**Hi!** How can I help?"],
    ["a list", "- read\n- write"],
    ["an empty reply", ""],
    ["a rambling reply", "Hello ".repeat(80)],
  ])("a reply with %s is replaced by the capability line", async (_label, reply) => {
    setLlmClient(client(() => reply));
    expect(await composeGreeting({ message: "hello" })).toMatchObject({ text: CAPABILITY_LINE, used: false });
  });

  it("a model that errors is replaced by the capability line, never an error", async () => {
    setLlmClient(client(() => new Error("503")));
    expect(await composeGreeting({ message: "hi" })).toMatchObject({ text: CAPABILITY_LINE, used: false });
  });
});
