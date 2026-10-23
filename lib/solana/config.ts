import { PublicKey } from "@solana/web3.js";

/**
 * Network configuration. The app talks to exactly one network: a Surfpool mainnet fork.
 *
 * The browser always uses the public `NEXT_PUBLIC_*` URLs. Server code (API routes, the
 * e2e script) may use a private loopback `FORK_RPC_URL` instead — set only when the app
 * is hosted on the same box as Surfpool.
 */
/** Default: the hosted Surfpool mainnet fork. */
const publicRpc = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://rpc-devnet.solana.vanna.finance";
const publicWs = process.env.NEXT_PUBLIC_SOLANA_WS_URL ?? "wss://rpc-devnet.solana.vanna.finance";

export const SOLANA_RPC_URL =
  typeof window === "undefined" ? (process.env.FORK_RPC_URL ?? publicRpc) : publicRpc;

export const SOLANA_WS_URL =
  typeof window === "undefined" ? (process.env.FORK_WS_URL ?? publicWs) : publicWs;

/** Public (browser-reachable) RPC URL — used for explorer `customUrl` links. */
export const PUBLIC_RPC_URL = publicRpc;

/** Label shown in the navbar network badge. */
export const NETWORK_LABEL = "Solana Mainnet Fork";

export const VANNA_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VANNA_PROGRAM_ID ?? "H37YVBG3eGtz89ofd7iDLc2PJgn12778392XeU2QJcGC",
);

/** Pyth Solana Receiver — owner of every PriceUpdateV2 account. */
/** The core program's oracle agent: prices every token (price book) and venue account (market book). */
export const ORACLE_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VANNA_ORACLE_PROGRAM_ID ?? "FXY5DRfekMUTbUp4uyCFpCZmCccrp6kPq3hTM4GRihnc",
);

/** The core program's validator agent: reviews every `margin_execute` call (Kamino, Jupiter, Titan, Ember, Phoenix). */
export const VALIDATOR_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VANNA_VALIDATOR_PROGRAM_ID ?? "6fND3vhtstp486iE6rsSNVUox3kcjNNRsSLAN7ZPs7th",
);

export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/** Pyth push-oracle program — derives the long-lived "price feed account" addresses. */
export const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
/** Shard 0 of the push oracle (the one every sponsored feed lives in). */
export const PYTH_SHARD_ID = 0;

export const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

/** Health-factor threshold: the account is liquidatable at HF <= 1.10 (strict > is healthy). */
export const LIQUIDATION_HEALTH_FACTOR = 1.1;
/**
 * UI safety buffer above the liquidation threshold: max-borrow / max-leverage / max-withdraw
 * helpers target HF >= this value so price drift between quote and execution can't trip the
 * strict on-chain `HF > 1.10` check.
 */
export const SAFE_HEALTH_FACTOR = 1.15;

/** Compute-unit limit used when several vanna instructions are batched into one tx. */
export const BATCH_COMPUTE_UNITS = 600_000;

/**
 * Explorer link for an address or transaction on the local fork (explorer.solana.com's
 * custom-cluster mode points at our RPC).
 */
export function explorerUrl(kind: "address" | "tx", value: string): string {
  return `https://explorer.solana.com/${kind}/${value}?cluster=custom&customUrl=${encodeURIComponent(PUBLIC_RPC_URL)}`;
}

/** Jupiter aggregator v6 program. */
export const JUPITER_V6_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
