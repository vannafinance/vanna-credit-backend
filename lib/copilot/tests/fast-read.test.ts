import { describe, expect, it } from "vitest";
import { matchFastRead } from "../fast-read";

describe("exact-match fast reads", () => {
  it.each([
    "what is my health factor?",
    "What's my health factor",
    "health factor",
    "my health",
    "check my hf",
    "show me my margin account health factor.",
    "please what is my health factor?!",
  ])("a bare health question is a health read: %s", (message) => {
    expect(matchFastRead(message)).toEqual({ kind: "health" });
  });

  it.each([
    ["price of SOL", "SOL"],
    ["What is the price of sol?", "SOL"],
    ["sol price", "SOL"],
    ["show me the current price of USDC", "USDC"],
  ])("a bare price question for one product asset is a price read: %s", (message, asset) => {
    const m = matchFastRead(message);
    expect(m).toMatchObject({ kind: "price" });
    expect((m as { assets: string[] }).assets.map((a) => a.toUpperCase())).toEqual([asset]);
  });

  it.each([
    "how much can i borrow?",
    "How much can I borrow",
    "how much can i safely borrow?",
    "what is my borrowing capacity?",
    "max borrow",
    "my borrow limit",
  ])("a bare borrowing-capacity question is a capacity read for every asset: %s", (message) => {
    expect(matchFastRead(message)).toEqual({ kind: "capacity", what: "borrow", asset: null });
  });

  it.each([
    "how much can i borrow if sol drops 30%",
    "how much can i borrow and then supply it",
    "how much can i borrow of usdc",
    "how much can i borrow against my sol",
    "how much can i borrow while keeping hf above 1.5",
    "borrow max",
    "can i borrow 500 usdc",
  ])("a capacity question with anything more is left to the investigation: %s", (message) => {
    expect(matchFastRead(message)).toBeNull();
  });

  it.each([
    "what happens to my health factor if SOL drops 30%?",
    "what is my health factor and borrow 5 USDC",
    "health factor then supply 100 USDC",
    "borrow 50 USDC but keep my health factor above 1.5",
    "price of SOL and ETH",
    "price of BTC",
    "what is the price of SOL when it hits 200",
    "should i borrow given my health factor",
    "hi",
    "",
    "   ",
  ])("anything else is left to the investigation: %s", (message) => {
    expect(matchFastRead(message)).toBeNull();
  });
});
