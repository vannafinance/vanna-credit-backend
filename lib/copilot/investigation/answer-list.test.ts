import { describe, expect, it } from "vitest";

import { answerToText } from "../answer-schema";
import { parseDecision } from "./decision";
import type { Observation } from "./types";

const read = (args: Record<string, unknown>, ok = true): Observation => ({
  tool: "get_predict_markets",
  args,
  ok,
  result: JSON.stringify({ summary: "8 Predict events listed.", events: [] }),
  ms: 0,
});
const ctx = (evidence: Observation[]) => ({ message: "show me prediction markets where I can bet", history: [], evidence });

describe("answer show_list (a whole list from the website's own endpoint)", () => {
  it("attaches the Predict list with the read's own filter, never rows the model picked", () => {
    const out = parseDecision("answer", { headline: "Here are the Predict events.", show_list: "predict_markets" }, ctx([read({ category: "sports", query: "  Barcelona " })]));
    expect(out.ok && out.outcome.kind === "answer" && out.outcome.answer).toMatchObject({
      venue: "predict",
      list: { kind: "predict_markets", category: "sports", query: "Barcelona" },
    });
  });

  it("uses the last successful read and drops a filter the read could not have used", () => {
    const out = parseDecision("answer", { headline: "Events.", show_list: "predict_markets" }, ctx([read({ query: "Rams" }), read({ category: "chess" }), read({ query: "x" }, false)]));
    expect(out.ok && out.outcome.kind === "answer" && out.outcome.answer.list).toEqual({ kind: "predict_markets" });
  });

  it("needs a Predict markets read first", () => {
    const out = parseDecision("answer", { headline: "Events.", show_list: "predict_markets" }, ctx([]));
    expect(out.ok).toBe(false);
  });

  it("an answer without show_list carries no list, and the text form names the list", () => {
    const plain = parseDecision("answer", { headline: "Events." }, ctx([read({})]));
    expect(plain.ok && plain.outcome.kind === "answer" && plain.outcome.answer.list).toBeUndefined();
    expect(answerToText({ headline: "Events.", facts: [], list: { kind: "predict_markets", category: "sports" } })).toContain("Predict events · sports");
  });
});
