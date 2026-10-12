import { describe, expect, it } from "vitest";
import { deriveAlerts } from "./alerts";
import type { AccountsSummary } from "./types";

const summary = (over: Partial<AccountsSummary>): AccountsSummary => ({
  total: 210, valued: 208, incomplete: 2, borrowers: 20, collateralUsd: 0, debtUsd: 0, equityUsd: 0,
  liquidatableCount: 0, liquidatableDebtUsd: 0, liquidatableCollateralUsd: 0,
  atRiskCount: 0, atRiskDebtUsd: 0, atRiskCollateralUsd: 0, badDebtUsd: 0, underwaterCount: 0,
  ...over,
} as AccountsSummary);

const derive = (s: AccountsSummary) => deriveAlerts({ summary: s, protocol: undefined, you: null, coverage: null, serviceError: false });

describe("deriveAlerts", () => {
  it("says how many of the valued accounts are close to the line and links to that list", () => {
    const risk = derive(summary({ atRiskCount: 17, atRiskCollateralUsd: 34_000 })).find((a) => a.id === "risk")!;
    expect(risk.priority).toBe("P2");
    expect(risk.title).toBe("17 of 208 valued accounts are close to the liquidation line");
    expect(risk.link).toBe("/analytics?filter=atrisk#accounts");
  });

  it("does not count liquidatable accounts as merely close to the line", () => {
    const alerts = derive(summary({ atRiskCount: 5, liquidatableCount: 5, liquidatableDebtUsd: 10, liquidatableCollateralUsd: 9, atRiskCollateralUsd: 9 }));
    expect(alerts.find((a) => a.id === "risk")).toBeUndefined();
    expect(alerts.find((a) => a.id === "liq")?.link).toBe("/analytics?filter=liquidatable#accounts");
  });

  it("links not-valued accounts to their filter", () => {
    expect(derive(summary({})).find((a) => a.id === "unvalued")?.link).toBe("/analytics?filter=incomplete#accounts");
  });

  it("is quiet when nothing is wrong", () => {
    expect(derive(summary({ incomplete: 0 }))).toEqual([]);
  });
});
