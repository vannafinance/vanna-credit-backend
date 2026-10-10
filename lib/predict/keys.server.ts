/**
 * Server-only fork keypairs for Predict (never sent to the browser).
 *
 * - Fork maker (`PREDICT_FORK_MAKER_SECRET_KEY`): co-signs every trade as World's market maker
 *   would. Holds fork funds only (topped up by cheatcode).
 * - Pool keeper (`PREDICT_POOL_KEEPER_SECRET_KEY`): signs `merge_and_deposit`. MUST equal the
 *   `keeper` stored in outcome_yield_pool's Config account (checked by `assertKeeperMatchesConfig`).
 *
 * Each is read from its env var (JSON byte array, e.g. a Cloud Run secret), else the legacy
 * `WORLD_*` env name used by Backend-Solana-v2, else `.cache/<file>.json` (gitignored). The maker
 * is generated on first use when nothing is configured; the keeper never is (a fresh key could not
 * merge), so a missing keeper is a configuration error.
 */
import { Keypair } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CACHE_DIR = path.join(process.cwd(), ".cache");
const g = globalThis as unknown as { __predictKeys?: Map<string, Keypair> };
const cache = (g.__predictKeys ??= new Map());

function fromJson(text: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text) as number[]));
}

function load(envNames: string[], file: string, generate: boolean): Keypair {
  const hit = cache.get(file);
  if (hit) return hit;
  let kp: Keypair | null = null;
  for (const name of envNames) {
    const v = process.env[name];
    if (v) {
      kp = fromJson(v);
      break;
    }
  }
  const filePath = path.join(CACHE_DIR, file);
  if (!kp && existsSync(filePath)) kp = fromJson(readFileSync(filePath, "utf8"));
  if (!kp) {
    if (!generate) throw new Error(`${envNames[0]} is not set (and .cache/${file} is missing)`);
    kp = Keypair.generate();
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)));
    } catch {
      /* read-only filesystem: the key lives for this process only */
    }
  }
  cache.set(file, kp);
  return kp;
}

export const getForkMaker = () => load(["PREDICT_FORK_MAKER_SECRET_KEY", "WORLD_FORK_MAKER_SECRET_KEY"], "predict-fork-maker.json", true);
export const getPoolKeeper = () => load(["PREDICT_POOL_KEEPER_SECRET_KEY", "WORLD_POOL_KEEPER_SECRET_KEY"], "predict-pool-keeper.json", false);
