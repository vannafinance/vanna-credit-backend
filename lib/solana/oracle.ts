import { Buffer } from "buffer";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { decodePriceUpdate, type OnchainPrice } from "./pyth";

/**
 * Client mirror of the oracle agent (`programs/vanna_oracle/src/pricing.rs`): every token has an
 * `OracleConfig` in the agent's price book (keyed by mint), and a price is read from the accounts
 * that config pins:
 *
 *   - Kamino Scope (`scope_prices` + `scope_chain`) is primary; a price is the PRODUCT of up to four
 *     `OraclePrices` entries (e.g. JitoSOL = stake rate × SOL/USD), stamped with its oldest entry.
 *   - Pyth (`pyth_price`, × `pyth_factor` when set, e.g. JupSOL = JUPSOL/SOL rate × SOL/USD) is the
 *     only source when Scope is unused, and the fallback while the Scope price is stale — used when
 *     it is newer.
 *   - Kamino receipts additionally carry `klend_reserve`; their USD value = underlying price × the
 *     reserve's cToken exchange rate (applied by the caller, see kamino.ts).
 *
 * Same choice as `vanna-credit-layer/scripts/src/oracle.ts::readPrice`, so a displayed health
 * factor matches the one the program computes from the same accounts.
 */

/** Marks an unused Scope chain slot (`SCOPE_CHAIN_UNUSED`). */
export const SCOPE_CHAIN_UNUSED = 65535;

export interface OracleConfigState {
  scopePrices: PublicKey;
  scopeChain: number[];
  scopeTwapChain: number[];
  pythPrice: PublicKey;
  pythFactor: PublicKey;
  klendReserve: PublicKey;
  klendProgram: PublicKey;
  maxAgeSecs: number;
  maxTwapDivergenceBps: number;
  maxConfidenceBps: number;
}

const isSet = (key: PublicKey) => !key.equals(PublicKey.default);

/** Normalises the Anchor-decoded `OracleConfig` (camelCase or snake_case field names). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normaliseOracle(o: any): OracleConfigState {
  const f = (camel: string, snake: string) => o?.[camel] ?? o?.[snake];
  const key = (camel: string, snake: string) => new PublicKey(f(camel, snake) ?? PublicKey.default);
  const chain = (camel: string, snake: string) => Array.from((f(camel, snake) ?? []) as number[]).map(Number);
  return {
    scopePrices: key("scopePrices", "scope_prices"),
    scopeChain: chain("scopeChain", "scope_chain"),
    scopeTwapChain: chain("scopeTwapChain", "scope_twap_chain"),
    pythPrice: key("pythPrice", "pyth_price"),
    pythFactor: key("pythFactor", "pyth_factor"),
    klendReserve: key("klendReserve", "klend_reserve"),
    klendProgram: key("klendProgram", "klend_program"),
    maxAgeSecs: Number(f("maxAgeSecs", "max_age_secs") ?? 0),
    maxTwapDivergenceBps: Number(f("maxTwapDivergenceBps", "max_twap_divergence_bps") ?? 0),
    maxConfidenceBps: Number(f("maxConfidenceBps", "max_confidence_bps") ?? 0),
  };
}

/** True for a Kamino cToken (priced as its underlying × the klend reserve's exchange rate). */
export function isReceiptOracle(o: OracleConfigState): boolean {
  return isSet(o.klendReserve);
}

/** The price accounts this oracle reads (Scope / Pyth / Pyth factor), without the klend reserve. */
export function priceAccounts(o: OracleConfigState): PublicKey[] {
  return [o.scopePrices, o.pythPrice, o.pythFactor].filter(isSet);
}

/** Every account the program needs to price this asset: its price accounts + a receipt's reserve. */
export function oracleAccounts(o: OracleConfigState): PublicKey[] {
  return [...priceAccounts(o), ...(isSet(o.klendReserve) ? [o.klendReserve] : [])];
}

/** `OraclePrices`: discriminator (8) | oracle_mappings (32) | 512 × DatedPrice (56 bytes:
 * value u64, exp u64, last_updated_slot u64, unix_timestamp u64, generic_data [u8; 24]). */
export function scopeEntryOffset(index: number): number {
  return 40 + 56 * index;
}

function readScopeChain(data: Buffer, chain: number[]): { value: bigint; exponent: number; timestamp: bigint } | null {
  const entries = chain.filter((e) => e !== SCOPE_CHAIN_UNUSED);
  if (entries.length === 0) return null;
  let value = 1n;
  let exponent = 0;
  let timestamp: bigint | null = null;
  for (const entry of entries) {
    const at = scopeEntryOffset(entry);
    if (data.length < at + 56) return null;
    const v = data.readBigUInt64LE(at);
    if (v === 0n) return null; // an unusable entry, as in the program
    value *= v;
    exponent -= Number(data.readBigUInt64LE(at + 8));
    const t = data.readBigUInt64LE(at + 24);
    timestamp = timestamp === null || t < timestamp ? t : timestamp;
  }
  return { value, exponent, timestamp: timestamp ?? 0n };
}

export type OracleSource = "scope" | "pyth";
export type OraclePrice = OnchainPrice & { source: OracleSource; fresh: boolean };

/**
 * The price the program would use now, from pre-fetched accounts (keyed by base58). `now` is the
 * fork clock (Clock sysvar unix_timestamp) — the program measures age against it, not wall time.
 * Null when neither source yields a usable price.
 */
export function priceFromAccounts(
  o: OracleConfigState,
  accounts: Map<string, AccountInfo<Buffer> | null>,
  now: bigint,
): OraclePrice | null {
  const isFresh = (t: bigint) => now - t <= BigInt(o.maxAgeSecs);
  let quote: Omit<OraclePrice, "fresh"> | null = null;

  if (isSet(o.scopePrices)) {
    const info = accounts.get(o.scopePrices.toBase58());
    const chain = info ? readScopeChain(Buffer.from(info.data), o.scopeChain) : null;
    if (chain) {
      quote = {
        price: chain.value,
        conf: 0n,
        exponent: chain.exponent,
        publishTime: chain.timestamp,
        usd: Number(chain.value) * 10 ** chain.exponent,
        source: "scope",
      };
    }
  }

  if (isSet(o.pythPrice) && !(quote && isFresh(quote.publishTime))) {
    const base = decodePriceUpdate(accounts.get(o.pythPrice.toBase58()) ?? null);
    if (base) {
      let fallback: Omit<OraclePrice, "fresh"> = { ...base, source: "pyth" };
      if (isSet(o.pythFactor)) {
        const factor = decodePriceUpdate(accounts.get(o.pythFactor.toBase58()) ?? null);
        fallback = factor
          ? {
              price: base.price * factor.price,
              conf: 0n,
              exponent: base.exponent + factor.exponent,
              publishTime: base.publishTime < factor.publishTime ? base.publishTime : factor.publishTime,
              usd: base.usd * factor.usd,
              source: "pyth",
            }
          : (null as unknown as Omit<OraclePrice, "fresh">);
      }
      if (fallback && (!quote || fallback.publishTime > quote.publishTime)) quote = fallback;
    }
  }

  return quote ? { ...quote, fresh: isFresh(quote.publishTime) } : null;
}

/** `OracleConfig` as `#[repr(C)]` bytes (184): scope_prices, scope_chain [u16; 4],
 * scope_twap_chain [u16; 4], pyth_price, pyth_factor, klend_reserve, klend_program, max_age_secs u32,
 * max_twap_divergence_bps u16, max_confidence_bps u16. */
export function decodeOracleConfig(data: Buffer, at: number): OracleConfigState {
  const key = (o: number) => new PublicKey(data.subarray(at + o, at + o + 32));
  const chain = (o: number) => [0, 1, 2, 3].map((i) => data.readUInt16LE(at + o + 2 * i));
  return {
    scopePrices: key(0),
    scopeChain: chain(32),
    scopeTwapChain: chain(40),
    pythPrice: key(48),
    pythFactor: key(80),
    klendReserve: key(112),
    klendProgram: key(144),
    maxAgeSecs: data.readUInt32LE(at + 176),
    maxTwapDivergenceBps: data.readUInt16LE(at + 180),
    maxConfidenceBps: data.readUInt16LE(at + 182),
  };
}

export interface PriceSource {
  mint: PublicKey;
  decimals: number;
  config: OracleConfigState;
}

/**
 * The oracle agent's `PriceBook` (zero-copy): discriminator (8) | bump u8 | count u8 | padding [2] |
 * 32 × PriceSource (mint 32 | decimals u8 | padding [3] | OracleConfig 184 = 220 bytes).
 */
export function decodePriceBook(data: Buffer): Map<string, PriceSource> {
  const sources = new Map<string, PriceSource>();
  if (data.length < 12) return sources;
  for (let i = 0; i < data[9]; i++) {
    const at = 12 + 220 * i;
    if (data.length < at + 220) break;
    const mint = new PublicKey(data.subarray(at, at + 32));
    sources.set(mint.toBase58(), { mint, decimals: data[at + 32], config: decodeOracleConfig(data, at + 36) });
  }
  return sources;
}

/** An unconfigured OracleConfig (a venue asset, or a token missing from the price book). */
export function emptyOracleConfig(): OracleConfigState {
  return {
    scopePrices: PublicKey.default,
    scopeChain: Array(4).fill(SCOPE_CHAIN_UNUSED),
    scopeTwapChain: Array(4).fill(SCOPE_CHAIN_UNUSED),
    pythPrice: PublicKey.default,
    pythFactor: PublicKey.default,
    klendReserve: PublicKey.default,
    klendProgram: PublicKey.default,
    maxAgeSecs: 0,
    maxTwapDivergenceBps: 0,
    maxConfidenceBps: 0,
  };
}

/** Human label for an oracle's sources, e.g. "Kamino Scope → Pyth fallback". */
export function oracleSourceLabel(o: OracleConfigState): string {
  const parts: string[] = [];
  if (isSet(o.scopePrices)) parts.push("Kamino Scope");
  if (isSet(o.pythPrice)) parts.push(parts.length ? (isSet(o.pythFactor) ? "Pyth × factor fallback" : "Pyth fallback") : "Pyth");
  if (isSet(o.klendReserve)) parts.push("× Kamino rate");
  return parts.join(" → ") || "—";
}
