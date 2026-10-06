/**
 * Stage 2 of a Copilot turn. See runtime.ts for the loop, catalog.ts for the read tools, decision.ts for how a decision
 * becomes something stage 3 can size, and prompt.ts for what the model is told.
 */
export { investigate, investigationDeps, investigationLimits } from "./runtime";
export { READ_TOOLS, executeRead } from "./catalog";
export { DECISION_TOOLS, parseDecision } from "./decision";
export type { InvestigationOutcome, InvestigationResult, InvestigationTrace, Observation } from "./types";
