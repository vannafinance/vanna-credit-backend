/**
 * Exact arithmetic for the model: totals, differences, USD values (amount x price), ratios and percentages.
 *
 * The model is never allowed to compute a figure itself (an answer may only state figures found in the evidence).
 * When the user asks for a total or a conversion no tool reports ("my total supplied balance in USD"), the model calls
 * `calculate` with figures copied from the evidence; the code checks every operand is in the evidence (or the user's
 * words), computes, and the result becomes evidence the answer may quote.
 */

import type { LlmFunctionDecl } from "../vertex";
import { numbersGrounded } from "../vertex";

export const CALCULATE_OPS = ["sum", "difference", "product", "ratio", "percent_of", "percent_change"] as const;
type CalcOp = (typeof CALCULATE_OPS)[number];

export const CALCULATE_TOOL: LlmFunctionDecl = {
  name: "calculate",
  description:
    "Exact arithmetic on figures already in the evidence, for totals, differences, USD values (amount x price), ratios and percentages the tools do not report. Copy each operand exactly as a tool result (or the user) gives it. The result is added to the evidence; quote it as returned. sum: all operands added. difference: first minus second. product: all multiplied (e.g. units x USD price). ratio: first divided by second. percent_of: first percent of second. percent_change: change from first to second, in percent.",
  parameters: {
    type: "OBJECT",
    properties: {
      operation: { type: "STRING", enum: [...CALCULATE_OPS] },
      operands: { type: "ARRAY", items: { type: "STRING" }, description: "The figures, copied from the evidence (2 to 12)." },
      label: { type: "STRING", description: "What the result is, e.g. \"total supplied in USD\"." },
    },
    required: ["operation", "operands"],
  },
};

const toNumber = (s: string): number | null => {
  const t = s.trim().replace(/^\$/, "").replace(/%$/, "").replace(/,/g, "");
  if (!/^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Up to 9 decimals, trailing zeros removed: precise enough for any token amount, short enough to read. */
const fmt = (n: number): string => {
  const s = n.toFixed(9).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

export function calculate(args: Record<string, unknown>, sources: string[]): { ok: boolean; result: Record<string, unknown> } {
  const op = args.operation as CalcOp;
  if (!CALCULATE_OPS.includes(op)) return { ok: false, result: { error: `operation must be one of ${CALCULATE_OPS.join(", ")}` } };
  const raw = Array.isArray(args.operands) ? args.operands.map((x) => String(x)) : [];
  if (raw.length < 2 || raw.length > 12) return { ok: false, result: { error: "give 2 to 12 operands" } };
  const values: number[] = [];
  for (const r of raw) {
    const n = toNumber(r);
    if (n === null) return { ok: false, result: { error: `"${r}" is not a plain number; copy the figure as digits` } };
    if (!numbersGrounded(r, sources)) return { ok: false, result: { error: `${r} is not in the evidence; read it first, then copy it exactly` } };
    values.push(n);
  }
  const two = op === "difference" || op === "ratio" || op === "percent_of" || op === "percent_change";
  if (two && values.length !== 2) return { ok: false, result: { error: `${op} takes exactly 2 operands` } };
  let value: number;
  switch (op) {
    case "sum":
      value = values.reduce((a, b) => a + b, 0);
      break;
    case "difference":
      value = values[0] - values[1];
      break;
    case "product":
      value = values.reduce((a, b) => a * b, 1);
      break;
    case "ratio":
      if (values[1] === 0) return { ok: false, result: { error: "division by zero" } };
      value = values[0] / values[1];
      break;
    case "percent_of":
      value = (values[0] * values[1]) / 100;
      break;
    case "percent_change":
      if (values[0] === 0) return { ok: false, result: { error: "percent change from zero is undefined" } };
      value = ((values[1] - values[0]) / values[0]) * 100;
      break;
  }
  const label = typeof args.label === "string" ? args.label.slice(0, 80) : op;
  return { ok: true, result: { label, operation: op, operands: raw, result: fmt(value), result_2dp: value.toFixed(2) } };
}
