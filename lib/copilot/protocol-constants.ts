/**
 * Program facts the Copilot shows and checks against, defined once. A leaf module (no imports) so client components
 * can use it without pulling server config into the browser bundle.
 */

/** The protocol's liquidation line (program `BALANCE_TO_BORROW_THRESHOLD_WAD`; MCP `risk.LIQUIDATION_HF`). At or below it, an account can be liquidated. */
export const LIQUIDATION_HF = 1.1;
/** How the line is written to users: "1.10". */
export const LIQUIDATION_HF_TEXT = LIQUIDATION_HF.toFixed(2);
