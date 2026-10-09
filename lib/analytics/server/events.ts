/**
 * Program events, decoded from the SAME transactions the registry already inspects (no extra RPC):
 * Anchor events are emitted in the transaction logs and parsed with the program's own coder.
 *
 * Only a bounded ring is kept (newest first by block time). Coverage is exactly the registry's scan
 * window — the UI says "in the last N program transactions", never "all history".
 */
import { PublicKey } from "@solana/web3.js";
import { getProgram, VANNA_IDL } from "@/lib/solana/program";
import { reservePda } from "@/lib/solana/pdas";
import { TOKENS } from "@/lib/solana/tokens";
import { KAMINO_RECEIPTS } from "@/lib/solana/kamino";
import { rawToNumber } from "@/lib/solana/math";

// MarginExecuted is deliberately NOT decoded: it holds variable-length lists and the dashboard does not show it.
const KEEP = new Set(["Liquidated", "CollateralSeized", "Borrowed", "DebtRepaid", "CollateralDeposited", "CollateralWithdrawn", "MarginCreated", "LiquiditySupplied", "LiquidityRedeemed"]);
const RING = 3000;
const NANO = 1e9;
const WAD = 1e18;

export interface ProgramEvent {
  id: string;
  signature: string;
  /** Unix seconds (block time of the transaction). */
  time: number | null;
  name: string;
  marginAccount: string | null;
  /** Wallet that acted: liquidator, payer, lender, or the margin's authority. */
  actor: string | null;
  symbol: string | null;
  /** Token units (UI) for the asset movement, when the event has one. */
  amount: number | null;
  /** Liquidated only — value of what was repaid / seized, USD (nano-USD from the program ÷ 1e9). */
  debtValueUsd: number | null;
  collateralValueUsd: number | null;
  /** Health factor reported by the program in the event (after the action, or at liquidation). */
  healthFactor: number | null;
}

/**
 * Safe event decoding. Older transactions on this network were emitted by earlier versions of the
 * program whose events share a name (and therefore the same 8-byte discriminator) but have a different
 * layout. Handing such bytes to the generic decoder made it read a bogus length and allocate gigabytes
 * (the server ran out of memory). So a log line is decoded ONLY if (1) its discriminator is a wanted
 * event and (2) its byte length is EXACTLY what the current layout needs. Anything else is skipped.
 */
const FIXED_SIZE: Record<string, number> = { pubkey: 32, bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16 };
const EXPECTED = new Map<string, { name: string; bytes: number }>();
for (const ev of (VANNA_IDL as unknown as { events: Array<{ name: string; discriminator: number[] }> }).events ?? []) {
  if (!KEEP.has(ev.name)) continue;
  const def = (VANNA_IDL.types as unknown as Array<{ name: string; type: { fields?: Array<{ type: unknown }> } }>).find((t) => t.name === ev.name);
  const sizes = def?.type.fields?.map((f) => (typeof f.type === "string" ? FIXED_SIZE[f.type] : undefined));
  if (!sizes || sizes.some((n) => n === undefined)) continue; // variable-length layout: never decoded
  EXPECTED.set(Buffer.from(ev.discriminator).toString("hex"), { name: ev.name, bytes: 8 + (sizes as number[]).reduce((a, b) => a + b, 0) });
}

function decodeLogs(logs: string[]): Array<{ name: string; data: Record<string, unknown> }> {
  const out: Array<{ name: string; data: Record<string, unknown> }> = [];
  const coder = getProgram().coder;
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const b64 = line.slice("Program data: ".length).trim();
    if (b64.length > 1024) continue;
    const bytes = Buffer.from(b64, "base64");
    const want = EXPECTED.get(bytes.subarray(0, 8).toString("hex"));
    if (!want || bytes.length !== want.bytes) continue;
    try {
      const ev = coder.events.decode(b64);
      if (ev) out.push({ name: ev.name, data: ev.data as Record<string, unknown> });
    } catch { /* a line that will not decode is skipped */ }
  }
  return out;
}

const reserveSymbol = new Map(TOKENS.map((t) => [reservePda(t.mint).toBase58(), t]));
const mintToken = new Map<string, { symbol: string; decimals: number }>([
  ...TOKENS.map((t) => [t.mint.toBase58(), { symbol: t.symbol, decimals: t.decimals }] as const),
  ...KAMINO_RECEIPTS.map((r) => [r.collateralMint.toBase58(), { symbol: r.symbol, decimals: 6 }] as const),
]);

const str = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "string" ? v : v instanceof PublicKey ? v.toBase58() : String((v as { toString(): string }).toString()));
const big = (v: unknown): bigint => { try { return BigInt(str(v) ?? "0"); } catch { return 0n; } };
const field = (d: Record<string, unknown>, camel: string, snake: string) => d[camel] ?? d[snake];

const events: ProgramEvent[] = [];
const seen = new Set<string>();

export function recordEvents(signature: string, time: number | null, logs: string[]): void {
  const parsed = decodeLogs(logs);
  parsed.forEach((parsedEvent, i) => {
    // Anchor's parser reports camelCase names (debtRepaid); the program's event names are PascalCase.
    const e = { ...parsedEvent, name: parsedEvent.name.charAt(0).toUpperCase() + parsedEvent.name.slice(1) };
    if (!KEEP.has(e.name)) return;
    const id = `${signature}:${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    const d = e.data;
    const reserve = str(field(d, "reserve", "reserve"));
    const mint = str(field(d, "mint", "mint"));
    const token = reserve ? reserveSymbol.get(reserve) : undefined;
    const m = mint ? mintToken.get(mint) : undefined;
    const raw = field(d, "assets", "assets") ?? field(d, "amount", "amount");
    const symbol = token?.symbol ?? m?.symbol ?? null;
    const decimals = token?.decimals ?? m?.decimals;
    const hfRaw = field(d, "healthFactorWad", "health_factor_wad") ?? field(d, "borrowHealthFactorWad", "borrow_health_factor_wad");
    events.push({
      id, signature, time, name: e.name,
      marginAccount: str(field(d, "marginAccount", "margin_account")),
      actor: str(field(d, "liquidator", "liquidator") ?? field(d, "payer", "payer") ?? field(d, "lender", "lender") ?? field(d, "authority", "authority")),
      symbol,
      amount: raw !== undefined && decimals !== undefined ? rawToNumber(big(raw), decimals) : null,
      debtValueUsd: e.name === "Liquidated" ? Number(big(field(d, "debtValue", "debt_value"))) / NANO : null,
      collateralValueUsd: e.name === "Liquidated" ? Number(big(field(d, "collateralValue", "collateral_value"))) / NANO : null,
      healthFactor: hfRaw !== undefined ? Number(big(hfRaw)) / WAD : null,
    });
  });
  if (events.length > RING) {
    events.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
    for (const gone of events.splice(RING)) seen.delete(gone.id);
  }
}

/** Newest first. */
export function listEvents(names?: string[], limit = 50): ProgramEvent[] {
  const pick = names?.length ? events.filter((e) => names.includes(e.name)) : events;
  return [...pick].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, limit);
}
export const eventCounts = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of events) out[e.name] = (out[e.name] ?? 0) + 1;
  return out;
};
export const eventsFingerprint = () => events.length;
export function exportEvents(limit = 1000): ProgramEvent[] { return listEvents(undefined, limit); }
export function importEvents(list: ProgramEvent[]): void {
  for (const e of list) { if (seen.has(e.id)) continue; seen.add(e.id); events.push(e); }
}
export function resetEventsForTests() { events.length = 0; seen.clear(); }
