import { describe, expect, it } from "vitest";
import { fmtAmount, fmtHf, fmtUsd, humanizeFailure } from "../explain";

describe("display formatting", () => {
  it("never renders a dust-sized negative as -0", () => {
    expect(fmtAmount("-0.00000001", "SOL")).toBe("0 SOL");
    expect(fmtAmount("1234.56789")).toBe("1,234.5679");
    expect(fmtAmount("x", "SOL")).toBe("x SOL");
  });
  it("formats health factors and dollars", () => {
    expect(fmtHf(null)).toBe("no debt");
    expect(fmtHf(undefined)).toBe("unavailable");
    expect(fmtHf(2.14159)).toBe("2.14");
    expect(fmtUsd(1146.031)).toBe("$1,146.03");
  });
  it("turns a screen of simulation logs into one sentence", () => {
    const raw = "TransactionErrorInstructionError((1, Tagged(Custom(InstructionErrorCustom(1)))))\nProgram log: Error: insufficient funds\nProgram ... failed";
    expect(humanizeFailure(raw)).toMatch(/does not hold enough/);
    expect(humanizeFailure("TransactionErrorInstructionError((5, Tagged(Custom(InstructionErrorCustom(6024)))))")).toMatch(/out of date/);
    expect(humanizeFailure("")).toMatch(/could not be prepared/);
    expect(humanizeFailure("x".repeat(500)).length).toBeLessThan(230);
  });
});
