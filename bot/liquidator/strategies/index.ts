import { phoenixStrategy } from "./phoenix";
import { tokenStrategy } from "./token";
import type { LiquidationStrategy } from "./types";

/**
 * Every strategy the bot knows. To add one (a new venue): write a file next to token.ts /
 * phoenix.ts that returns a `LiquidationAction` (with `venue` calls when it unwinds a position), then
 * list it here.
 */
export const STRATEGIES: LiquidationStrategy[] = [tokenStrategy, phoenixStrategy];

/** The enabled strategies (`STRATEGIES` env, default all). */
export function enabledStrategies(names: string[]): LiquidationStrategy[] {
  if (!names.length) return STRATEGIES;
  const unknown = names.filter((n) => !STRATEGIES.some((s) => s.name === n));
  if (unknown.length) throw new Error(`Unknown strategies: ${unknown.join(", ")}`);
  return STRATEGIES.filter((s) => names.includes(s.name));
}

export type { Candidate, LiquidationAction, LiquidationStrategy } from "./types";
