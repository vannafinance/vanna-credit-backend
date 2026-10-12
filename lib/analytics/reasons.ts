import type { IncompleteReason } from "./types";

/** Plain-language wording for why an account cannot be valued (the API sends codes, never sentences). */
export function reasonText(r: IncompleteReason): string {
  switch (r.code) {
    case "missing_price": return `No price is available yet for ${r.symbols.join(", ")}, so it can't be valued.`;
    case "receipt_unreadable": return `A Kamino deposit it holds could not be read (${r.symbols.join(", ")}).`;
    case "unknown_asset": return r.assetIndexes.length ? `It refers to asset #${r.assetIndexes.join(", #")}, which is not registered with the protocol on this network (the program lists no configuration for it), so its value can't be worked out.` : "Part of the account could not be read.";
    case "venue_unreadable": return "Its Phoenix perps account could not be read.";
  }
}
