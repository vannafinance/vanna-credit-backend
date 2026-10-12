/**
 * Durable copy of the analytics scan state, so a restart (or a new Cloud Run instance) RESUMES
 * instead of re-reading every program transaction (~2.5 minutes for a 1,500-transaction window).
 *
 * What is saved: the account registry (margin accounts, first-seen times, scan cursors, the queue of
 * transactions not yet inspected), the decoded event ring and the server-measured health readings.
 * Also saved: the LAST SNAPSHOT of account rows (with the time it was measured), shown immediately after a
 * restart while a fresh read runs in the background. It is always presented with its own "as of" time and is
 * replaced by the first new read; it is never treated as current.
 * Everything saved is public chain data; nothing here is secret, so it is stored as plain JSON.
 *
 * Backends (chosen once, never silently mixed):
 *   - ANALYTICS_FIRESTORE_PROJECT set  → Firestore over REST (same auth as the Copilot store; no new
 *                                         dependency). Shared by every instance, last writer wins - safe
 *                                         because the data is derived and re-scannable.
 *   - otherwise in development        → a local JSON file under /.local (git-ignored).
 *   - otherwise (production, no store) → memory only; the dashboard still works and says so.
 *
 * A saved state is only trusted if it still matches the network: same program id and its newest
 * transaction still exists on the fork (a fork reset invalidates it, and it is then discarded).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GoogleAuth } from "google-auth-library";
import type { ProgramEvent } from "./events";
import type { AccountRow } from "../types";

export const SCHEMA = 1;

export interface PersistedRegistry {
  margins: Array<[string, string]>;
  firstSeen: Array<[string, number]>;
  queue: Array<{ signature: string; blockTime: number | null }>;
  newestSignature: string | null;
  oldestSignature: string | null;
  discovered: number;
  inspected: number;
  oldestInspectedTime: number | null;
  backfillExhausted: boolean;
}

export interface PersistedState {
  v: number;
  savedAt: number;
  program: string;
  registry: PersistedRegistry;
  events: ProgramEvent[];
  hfHistory: Record<string, number[]>;
  /** margin → asset indexes whose vault held a balance when last probed. Optional: older saves lack it. */
  vaults?: Record<string, number[]>;
  /** Last published account rows and when / against which fork clock they were measured. Optional: older saves lack it. */
  rows?: AccountRow[];
  rowsAt?: number;
  rowsForkTime?: number;
}

export type Backend = "firestore" | "file" | "memory";

interface Store { backend: Backend; load(): Promise<PersistedState | null>; save(state: PersistedState): Promise<void> }

const project = process.env.ANALYTICS_FIRESTORE_PROJECT;
const database = process.env.ANALYTICS_FIRESTORE_DATABASE ?? "(default)";
const collection = process.env.ANALYTICS_FIRESTORE_COLLECTION ?? "solana_analytics";
const CHUNK = 400_000; // chars per Firestore document (limit is 1 MiB)
const MAX_CHUNKS = 12;

/**
 * Splits the saved state into Firestore-sized pieces. The cached account rows are only a convenience (shown at once
 * after a restart), so if the whole state would not fit they are dropped rather than losing the scan state, which is
 * the expensive part to rebuild. Throws only when even the scan state alone is too large.
 */
export function encodeState(state: PersistedState): { parts: string[]; rowsDropped: boolean } {
  const split = (json: string) => Array.from({ length: Math.ceil(json.length / CHUNK) }, (_, i) => json.slice(i * CHUNK, (i + 1) * CHUNK));
  let parts = split(JSON.stringify(state));
  if (parts.length <= MAX_CHUNKS) return { parts, rowsDropped: false };
  if (state.rows) {
    parts = split(JSON.stringify({ ...state, rows: undefined, rowsAt: undefined, rowsForkTime: undefined }));
    if (parts.length <= MAX_CHUNKS) return { parts, rowsDropped: true };
  }
  throw new Error("state_too_large");
}

class FileStore implements Store {
  backend = "file" as const;
  private readonly dir = resolve(/* turbopackIgnore: true */ process.cwd(), ".local", "analytics");
  private readonly file = join(this.dir, "state.json");
  async load() {
    try { return JSON.parse(await readFile(this.file, "utf8")) as PersistedState; } catch { return null; }
  }
  async save(state: PersistedState) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, this.file); // atomic: a crash never leaves half a file
  }
}

class FirestoreStore implements Store {
  backend = "firestore" as const;
  private readonly base: string;
  constructor(p: string) {
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(p) || !/^(\(default\)|[a-z0-9-]+)$/.test(database) || !/^[a-z][a-z0-9_]{2,60}$/.test(collection)) throw new Error("invalid_firestore_configuration");
    this.base = `https://firestore.googleapis.com/v1/projects/${p}/databases/${database}/documents/${collection}`;
  }
  private async headers() {
    const token = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/datastore"] }).getAccessToken();
    if (!token) throw new Error("store_auth_unavailable");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }
  private async get(id: string): Promise<string | null> {
    const res = await fetch(`${this.base}/${id}`, { headers: await this.headers(), signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`store_http_${res.status}`);
    const body = await res.json();
    return typeof body.fields?.json?.stringValue === "string" ? body.fields.json.stringValue : null;
  }
  private async put(id: string, json: string) {
    const res = await fetch(`${this.base}/${id}`, { method: "PATCH", headers: await this.headers(), body: JSON.stringify({ fields: { json: { stringValue: json } } }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`store_http_${res.status}`);
  }
  async load() {
    const meta = await this.get("state_meta");
    if (!meta) return null;
    const { chunks } = JSON.parse(meta) as { chunks: number };
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) return null;
    const parts: string[] = [];
    for (let i = 0; i < chunks; i++) { const part = await this.get(`state_${i}`); if (part === null) return null; parts.push(part); }
    return JSON.parse(parts.join("")) as PersistedState;
  }
  async save(state: PersistedState) {
    const { parts } = encodeState(state);
    for (let i = 0; i < parts.length; i++) await this.put(`state_${i}`, parts[i]);
    await this.put("state_meta", JSON.stringify({ chunks: parts.length, savedAt: state.savedAt })); // last: readers never see a half-written set
  }
}

const memory: Store = { backend: "memory", load: async () => null, save: async () => undefined };

function choose(): Store {
  try {
    if (project) return new FirestoreStore(project);
    if (process.env.NODE_ENV !== "production") return new FileStore();
  } catch { /* invalid configuration → memory only */ }
  return memory;
}
const store = choose();

export const persistenceBackend = (): Backend => store.backend;
export const loadState = () => store.load();
export const saveState = (state: PersistedState) => store.save(state);
