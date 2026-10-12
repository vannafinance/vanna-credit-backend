import { describe, expect, it } from "vitest";
import { accountHref, parseFrom, trailFor } from "./links";

describe("account links", () => {
  it("builds the account URL with where the visitor came from", () => {
    expect(accountHref("CKMk2abc", "top")).toBe("/analytics/accounts/CKMk2abc?from=top");
  });
  it("only accepts known origins and defaults to the Overview", () => {
    expect(parseFrom("liquidations")).toBe("liquidations");
    expect(parseFrom(["alerts", "x"])).toBe("alerts");
    expect(parseFrom("../../evil")).toBe("overview");
    expect(parseFrom(undefined)).toBe("overview");
  });
  it("gives Overview > Accounts for the Overview and Top accounts > Largest borrowers for Top accounts", () => {
    expect(trailFor("overview").map((c) => c.label)).toEqual(["Overview", "Accounts"]);
    expect(trailFor("top").map((c) => c.label)).toEqual(["Top accounts", "Largest borrowers"]);
  });
});
