import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FirestoreRecordStore, HASH_ID, LocalRecordStore, durableStore, workflowStore } from "./store";

const SECRET = "s".repeat(40);

describe("LocalRecordStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "copilot-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates, reads and updates with versions", async () => {
    const store = new LocalRecordStore<{ n: number }>(dir, SECRET);
    const id = randomUUID();
    expect(await store.read(id)).toBeNull();
    expect(await store.write(id, null, { n: 1 })).toBe(true);
    const a = await store.read(id);
    expect(a?.value).toEqual({ n: 1 });
    expect(await store.write(id, a!.version, { n: 2 })).toBe(true);
    expect((await store.read(id))?.value).toEqual({ n: 2 });
  });

  it("rejects a stale version and a second create (CAS)", async () => {
    const store = new LocalRecordStore<{ n: number }>(dir, SECRET);
    const id = randomUUID();
    await store.write(id, null, { n: 1 });
    expect(await store.write(id, null, { n: 9 })).toBe(false);
    const v = (await store.read(id))!.version;
    await store.write(id, v, { n: 2 });
    expect(await store.write(id, v, { n: 3 })).toBe(false);
    expect((await store.read(id))?.value).toEqual({ n: 2 });
  });

  it("lets exactly one of many concurrent writers win", async () => {
    const store = new LocalRecordStore<{ who: number }>(dir, SECRET);
    const id = randomUUID();
    await store.write(id, null, { who: -1 });
    const v = (await store.read(id))!.version;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.write(id, v, { who: i })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("seals records and binds them to their id", async () => {
    const store = new LocalRecordStore<{ secret: string }>(dir, SECRET);
    const id = randomUUID();
    await store.write(id, null, { secret: "plaintext-marker" });
    const raw = await readFile(join(dir, `${id}.0.json`), "utf8");
    expect(raw).not.toContain("plaintext-marker");
    const other = randomUUID();
    await copyFile(join(dir, `${id}.0.json`), join(dir, `${other}.0.json`));
    await expect(store.read(other)).rejects.toThrow();
  });

  it("refuses ids that could escape the directory, and short secrets", async () => {
    const store = new LocalRecordStore<unknown>(dir, SECRET);
    await expect(store.read("../etc/passwd")).rejects.toThrow("invalid_record_id");
    expect(() => new LocalRecordStore(dir, "short")).toThrow("store_secret_required");
    const hashed = new LocalRecordStore<unknown>(dir, SECRET, HASH_ID);
    await expect(hashed.read(randomUUID())).rejects.toThrow("invalid_record_id");
  });
});

describe("FirestoreRecordStore", () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const make = (request: typeof fetch) =>
    new FirestoreRecordStore<{ n: number }>(
      "my-project-1",
      "(default)",
      SECRET,
      "solana_copilot_workflows",
      undefined,
      async () => "tok",
      request,
    );

  it("uses exists=false to create and updateTime to update, and maps 412/409/400 to a lost race", async () => {
    const urls: string[] = [];
    const statuses = [200, 412, 409, 400];
    const request = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      const status = statuses.shift()!;
      return status === 400 ? reply({ error: { status: "FAILED_PRECONDITION" } }, 400) : reply({}, status);
    }) as unknown as typeof fetch;
    const store = make(request);
    const id = randomUUID();
    expect(await store.write(id, null, { n: 1 })).toBe(true);
    expect(urls[0]).toContain("currentDocument.exists=false");
    expect(await store.write(id, "2026-01-01T00:00:00Z", { n: 2 })).toBe(false);
    expect(urls[1]).toContain("currentDocument.updateTime=2026-01-01T00%3A00%3A00Z");
    expect(await store.write(id, null, { n: 3 })).toBe(false);
    expect(await store.write(id, null, { n: 4 })).toBe(false);
  });

  it("round-trips a sealed payload; 404 is absent; other errors throw", async () => {
    let sealedBody = "";
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        sealedBody = JSON.parse(String(init.body)).fields.payload.stringValue;
        return reply({});
      }
      if (!sealedBody) return reply({}, 404);
      return reply({ updateTime: "t1", fields: { payload: { stringValue: sealedBody } } });
    }) as unknown as typeof fetch;
    const store = make(request);
    const id = randomUUID();
    expect(await store.read(id)).toBeNull();
    await store.write(id, null, { n: 7 });
    expect(sealedBody).not.toContain('"n"');
    expect(await store.read(id)).toEqual({ version: "t1", value: { n: 7 } });
    const failing = make((async () => reply({}, 500)) as unknown as typeof fetch);
    await expect(failing.read(id)).rejects.toThrow("store_http_500");
  });

  it("validates project, database and collection names", () => {
    expect(() => new FirestoreRecordStore("Bad Project", "(default)", SECRET, "solana_copilot_x")).toThrow("invalid_firestore_configuration");
    expect(() => new FirestoreRecordStore("my-project-1", "(default)", SECRET, "x/../y")).toThrow("invalid_firestore_configuration");
  });
});

describe("durableStore selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses local files in development when no Firestore project is set", () => {
    vi.stubEnv("COPILOT_FIRESTORE_PROJECT", "");
    vi.stubEnv("COPILOT_STORE_SECRET", SECRET);
    expect(workflowStore()).toBeInstanceOf(LocalRecordStore);
  });

  it("uses Firestore when COPILOT_FIRESTORE_PROJECT is set", () => {
    vi.stubEnv("COPILOT_FIRESTORE_PROJECT", "my-project-1");
    expect(durableStore("solana_copilot_workflows", ".local/x", SECRET)).toBeInstanceOf(FirestoreRecordStore);
  });

  it("fails hard in production with no project (never falls back to local files)", () => {
    vi.stubEnv("COPILOT_FIRESTORE_PROJECT", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => durableStore("solana_copilot_workflows", ".local/x", SECRET)).toThrow("durable_store_not_configured");
  });
});
