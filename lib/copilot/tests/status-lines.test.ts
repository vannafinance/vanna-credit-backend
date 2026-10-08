/** The model-worded progress lines shown while a reply is worked out: only safe, short, figure-free lines survive. */
import { describe, expect, it } from "vitest";
import { cleanStatusLines } from "../status-lines";

describe("cleanStatusLines", () => {
  it("keeps short action lines and ends each with an ellipsis", () => {
    expect(cleanStatusLines(["Reading your margin account…", "Checking the SOL price...", "Sizing the borrow"])).toEqual([
      "Reading your margin account…",
      "Checking the SOL price…",
      "Sizing the borrow…",
    ]);
  });

  it("drops lines with figures, claimed results or too much text", () => {
    expect(
      cleanStatusLines([
        "Borrowing 500 USDC…",
        "Transaction signed…",
        "Plan approved and executed…",
        "Looking at every single position you hold across every venue…",
        "Checking your health factor…",
      ]),
    ).toEqual(["Checking your health factor…"]);
  });

  it("caps the list and ignores anything that is not a list of strings", () => {
    expect(cleanStatusLines(["a…", "b…", "c…", "d…", "e…"])).toHaveLength(4);
    expect(cleanStatusLines("Reading…")).toEqual([]);
    expect(cleanStatusLines([1, null, "  "])).toEqual([]);
  });
});
