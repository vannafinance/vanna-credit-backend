import type { IncompleteReason } from "./types";

/** Plain-language wording for why an account cannot be valued (the API sends codes, never sentences). */
export function reasonText(r: IncompleteReason): string {
  switch (r.code) {
    case "stale_price": return `The price of ${r.symbols.join(", ")} has not been updated recently, so it can't be valued yet.`;
    case "missing_price": return `No price is available yet for ${r.symbols.join(", ")}, so it can't be valued.`;
    case "receipt_unreadable": return `A Kamino deposit it holds could not be read (${r.symbols.join(", ")}).`;
    case "unknown_asset": return r.assetIndexes.length ? `It holds a position in an asset or venue this dashboard does not recognise yet (asset #${r.assetIndexes.join(", #")}), so its value can't be worked out.` : "Part of the account could not be read.";
    case "venue_unreadable": return "Its Phoenix perps account could not be read.";
  }
}
