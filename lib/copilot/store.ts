import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, open, link, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { GoogleAuth } from "google-auth-library";

import { copilotConfig } from "./config";

export interface Stored<T> {
  value: T;
  version: string;
}

export interface RecordStore<T> {
  read(id: string): Promise<Stored<T> | null>;
  /** `expected` null means create-if-absent. False means another request already won (CAS lost). */
  write(id: string, expected: string | null, value: T): Promise<boolean>;
}

/**
 * What a document id may look like. Anything unchecked would reach a file path and a URL, so each
 * store declares its own rule: UUIDs for workflows/conversations, sha256 hex for hashed keys.
 */
export type IdRule = RegExp;
export const UUID_ID: IdRule = /^[a-f0-9-]{36}$/;
export const HASH_ID: IdRule = /^[a-f0-9]{64}$/;
const check = (rule: IdRule, id: string) => {
  if (!rule.test(id)) throw new Error("invalid_record_id");
};

/** Records are sealed with a key derived from their own secret, independent of the session cookie key. */
function encryption(secret: string) {
  if (secret.length < 32) throw new Error("store_secret_required");
  const key = Buffer.from(hkdfSync("sha256", secret, "vanna-solana-copilot", "record-v1", 32));
  return {
    seal(id: string, value: unknown) {
      const plaintext = JSON.stringify(value);
      if (Buffer.byteLength(plaintext) > 400_000) throw new Error("record_too_large");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      // The id is authenticated data: a sealed record cannot be replayed under another id.
      cipher.setAAD(Buffer.from(id));
      const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
    },
    open<T>(id: string, sealed: string): T {
      const [iv, tag, data, extra] = sealed.split(".");
      if (!iv || !tag || !data || extra || sealed.length > 600_000) throw new Error("invalid_record");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8"),
      ) as T;
    },
  };
}

/**
 * Development journal: immutable revisions, fsync before atomic link publication. Concurrent
 * writers contend on the SAME next filename and only one can create it, so a lost race is a clean
 * CAS failure and a crash never leaves a half-written published revision. Never used in production.
 */
export class LocalRecordStore<T> implements RecordStore<T> {
  private readonly directory: string;
  private readonly codec: ReturnType<typeof encryption>;

  constructor(directory: string, secret: string, private readonly idRule: IdRule = UUID_ID) {
    this.directory = resolve(directory);
    this.codec = encryption(secret);
  }

  async read(id: string): Promise<Stored<T> | null> {
    check(this.idRule, id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const versions = (await readdir(this.directory))
      .filter((file) => file.startsWith(`${id}.`) && /\.\d+\.json$/.test(file))
      .map((file) => Number(file.split(".")[1]))
      .filter(Number.isSafeInteger);
    if (!versions.length) return null;
    const version = String(Math.max(...versions));
    const sealed = await readFile(join(this.directory, `${id}.${version}.json`), "utf8");
    return { version, value: this.codec.open<T>(`${id}:${version}`, sealed) };
  }

  async write(id: string, expected: string | null, value: T): Promise<boolean> {
    check(this.idRule, id);
    const current = await this.read(id);
    if ((current?.version ?? null) !== expected) return false;
    const version = expected === null ? 0 : Number(expected) + 1;
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("invalid_record_version");
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(this.codec.seal(`${id}:${version}`, value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, join(this.directory, `${id}.${version}.json`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}

/** Shared durable store. Firestore `exists` / `updateTime` preconditions are the compare-and-set. */
export class FirestoreRecordStore<T> implements RecordStore<T> {
  private readonly base: string;
  private readonly codec: ReturnType<typeof encryption>;

  constructor(
    project: string,
    database: string,
    secret: string,
    collection: string,
    private readonly idRule: IdRule = UUID_ID,
    private readonly token: () => Promise<string> = async () => {
      const token = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/datastore"] }).getAccessToken();
      if (!token) throw new Error("store_auth_unavailable");
      return token;
    },
    private readonly request: typeof fetch = fetch,
  ) {
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) || !/^(\(default\)|[a-z0-9-]+)$/.test(database)) {
      throw new Error("invalid_firestore_configuration");
    }
    if (!/^[a-z][a-z0-9_]{2,60}$/.test(collection)) throw new Error("invalid_firestore_configuration");
    this.base = `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents/${collection}`;
    this.codec = encryption(secret);
  }

  async read(id: string): Promise<Stored<T> | null> {
    check(this.idRule, id);
    const response = await this.request(`${this.base}/${id}`, {
      headers: { Authorization: `Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`store_http_${response.status}`);
    const body = await response.json();
    if (typeof body.updateTime !== "string" || typeof body.fields?.payload?.stringValue !== "string") {
      throw new Error("invalid_record");
    }
    return { version: body.updateTime, value: this.codec.open<T>(id, body.fields.payload.stringValue) };
  }

  async write(id: string, expected: string | null, value: T): Promise<boolean> {
    check(this.idRule, id);
    const query =
      expected === null ? "currentDocument.exists=false" : `currentDocument.updateTime=${encodeURIComponent(expected)}`;
    const response = await this.request(`${this.base}/${id}?${query}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { payload: { stringValue: this.codec.seal(id, value) } } }),
      signal: AbortSignal.timeout(15_000),
    });
    if ([409, 412].includes(response.status)) return false;
    // A failed precondition can also arrive as 400 FAILED_PRECONDITION.
    if (response.status === 400) {
      const body = await response.json().catch(() => null);
      if (body?.error?.status === "FAILED_PRECONDITION") return false;
    }
    if (!response.ok) throw new Error(`store_http_${response.status}`);
    return true;
  }
}

/**
 * One durable store for one collection, chosen the same way for every caller: Firestore when
 * COPILOT_FIRESTORE_PROJECT is set, local encrypted files in development, and a hard failure in
 * production. A silent fall back to a container filesystem would lose plans on redeploy and be
 * invisible to sibling instances, which for approvals and limits is a correctness bug.
 *
 * Only COPILOT_FIRESTORE_PROJECT selects Firestore (not GOOGLE_CLOUD_PROJECT, which local Vertex
 * setups also set and which does not necessarily have a database).
 */
export function durableStore<T>(
  collection: string,
  localDir: string,
  secret: string,
  idRule: IdRule = UUID_ID,
): RecordStore<T> {
  const project = copilotConfig.firestoreProject;
  if (project) {
    return new FirestoreRecordStore<T>(project, copilotConfig.firestoreDatabase, secret, collection, idRule);
  }
  if (copilotConfig.isProduction) throw new Error("durable_store_not_configured");
  // Runtime development data, never a build asset. Do not trace the entire repository.
  return new LocalRecordStore<T>(resolve(/* turbopackIgnore: true */ process.cwd(), localDir), secret, idRule);
}

const collectionName = (suffix: string) => `${copilotConfig.collectionPrefix}${suffix}`;

export function workflowStore<T>(): RecordStore<T> {
  return durableStore<T>(collectionName("workflows"), ".local/solana-copilot/workflows", copilotConfig.storeSecret, UUID_ID);
}

export function conversationStore<T>(): RecordStore<T> {
  return durableStore<T>(
    collectionName("conversations"),
    ".local/solana-copilot/conversations",
    copilotConfig.storeSecret,
    UUID_ID,
  );
}

/** Rate / spend counters and SIWS nonces. Keys are sha256 hex so user input never names a document. */
export function limitStore<T>(): RecordStore<T> {
  return durableStore<T>(collectionName("limits"), ".local/solana-copilot/limits", copilotConfig.storeSecret, HASH_ID);
}
