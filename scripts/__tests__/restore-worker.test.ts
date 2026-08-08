import { beforeEach, describe, expect, it } from "vitest";
import type {
  KVNamespace,
  R2Bucket,
  R2Object,
  R2ObjectBody,
} from "@cloudflare/workers-types/experimental";
import { CURRENT_ARCHIVE_KEY } from "../../app/news-archive";
import { canonicalizeNewsDocument } from "../../app/news-data";
import { handleRestoreRequest, type RestoreBindings } from "../restore-worker";

const snapshotKey = "daily/2026/08/02/2026-08-01T18-15-00Z-abc123def456.json";

const createNews = (id: number, newsDate = "2026年08月01日 12時00分00秒") => ({
  id,
  targetUrl: `/info/${id}`,
  title: `ニュース${id}`,
  newsDate,
  updated: newsDate,
});

const snapshotDocument = {
  news: [
    createNews(2, "2026年08月01日 12時00分00秒"),
    createNews(1, "2019年09月24日 00時00分00秒"),
  ],
};

type SetupOptions = {
  snapshot?: unknown;
  snapshotReadError?: boolean;
  currentEtag?: string | null;
  putResult?: "success" | "conflict" | "error";
  cacheDeleteError?: boolean;
};

const createSetup = (options: SetupOptions = {}) => {
  const calls: string[] = [];
  const puts: Array<{ key: string; value: string; options: Record<string, unknown> }> = [];
  const snapshot = options.snapshot ?? snapshotDocument;
  const currentEtag = options.currentEtag === undefined ? "current-etag" : options.currentEtag;
  const putResult = options.putResult ?? "success";

  const backupBucket = {
    get: async (key: string) => {
      calls.push(`backup:get:${key}`);
      return {
        text: async () => {
          if (options.snapshotReadError) throw new Error("snapshot read failed");
          return typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
        },
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;

  const dataBucket = {
    head: async (key: string) => {
      calls.push(`data:head:${key}`);
      return currentEtag === null ? null : ({ etag: currentEtag } as R2Object);
    },
    put: async (key: string, value: string, putOptions: Record<string, unknown>) => {
      calls.push(`data:put:${key}`);
      puts.push({ key, value, options: putOptions });
      if (putResult === "error") throw new Error("put failed");
      if (putResult === "conflict") return null;
      return { etag: "updated-etag" } as R2Object;
    },
  } as unknown as R2Bucket;

  const cache = {
    delete: async (key: string) => {
      calls.push(`cache:delete:${key}`);
      if (options.cacheDeleteError) throw new Error("delete failed");
    },
  } as unknown as KVNamespace;

  return {
    env: {
      KF3_NOTIF_BACKUP: backupBucket,
      KF3_NOTIF_DATA: dataBucket,
      KF3_NOTIF_CACHE: cache,
    } satisfies RestoreBindings,
    calls,
    puts,
  };
};

const callRestore = async (env: RestoreBindings, body: Record<string, unknown>) =>
  handleRestoreRequest(
    new Request("http://127.0.0.1:8790/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );

const readBody = async (response: Response) => response.json() as Promise<Record<string, any>>;

describe("operator-only復元tool", () => {
  beforeEach(() => {
    expect.hasAssertions();
  });

  it("default dry-runでsnapshotを検証し、writeを行わない", async () => {
    const setup = createSetup();
    const response = await callRestore(setup.env, { snapshotKey });
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mode: "dry-run",
      snapshot: {
        key: snapshotKey,
        count: 2,
        oldestNewsDate: "2019年09月24日 00時00分00秒",
        newestNewsDate: "2026年08月01日 12時00分00秒",
      },
      current: { key: CURRENT_ARCHIVE_KEY, etag: "current-etag" },
      writes: { r2Puts: 0, kvDeletes: 0 },
    });
    expect(setup.calls).toEqual([`backup:get:${snapshotKey}`, `data:head:${CURRENT_ARCHIVE_KEY}`]);
    expect(setup.puts).toHaveLength(0);
  });

  it("schemaまたは日付が不正なsnapshotを拒否する", async () => {
    const setup = createSetup({ snapshot: { news: [{ id: 1 }] } });
    const response = await callRestore(setup.env, { snapshotKey });

    expect(response.status).toBe(422);
    expect(await readBody(response)).toMatchObject({
      error: { code: "snapshot_validation_failed" },
    });
  });

  it("snapshot本文の読み込み失敗をR2エラーとして返す", async () => {
    const setup = createSetup({ snapshotReadError: true });
    const response = await callRestore(setup.env, { snapshotKey });

    expect(response.status).toBe(502);
    expect(await readBody(response)).toMatchObject({
      error: { code: "snapshot_read_failed" },
    });
  });

  it("applyでsnapshot digestの再入力を検証する", async () => {
    const setup = createSetup();
    const response = await callRestore(setup.env, {
      mode: "apply",
      snapshotKey,
      snapshotDigest: "wrong-digest",
      currentEtag: "current-etag",
    });

    expect(response.status).toBe(409);
    expect(await readBody(response)).toMatchObject({
      error: { code: "snapshot_digest_mismatch" },
    });
    expect(setup.puts).toHaveLength(0);
  });

  it("applyでcurrent ETagの再入力を検証する", async () => {
    const setup = createSetup();
    const digest = (await canonicalizeNewsDocument(snapshotDocument)).digest;
    const response = await callRestore(setup.env, {
      mode: "apply",
      snapshotKey,
      snapshotDigest: digest,
      currentEtag: "stale-etag",
    });

    expect(response.status).toBe(409);
    expect(await readBody(response)).toMatchObject({ error: { code: "current_etag_mismatch" } });
    expect(setup.puts).toHaveLength(0);
  });

  it("条件付きputがnullなら競合としてKVを削除しない", async () => {
    const setup = createSetup({ putResult: "conflict" });
    const digest = (await canonicalizeNewsDocument(snapshotDocument)).digest;
    const response = await callRestore(setup.env, {
      mode: "apply",
      snapshotKey,
      snapshotDigest: digest,
      currentEtag: "current-etag",
    });

    expect(response.status).toBe(409);
    expect(await readBody(response)).toMatchObject({ error: { code: "current_update_conflict" } });
    expect(setup.calls).not.toContain("cache:delete:kf3-news");
  });

  it("put失敗時はKVを削除しない", async () => {
    const setup = createSetup({ putResult: "error" });
    const digest = (await canonicalizeNewsDocument(snapshotDocument)).digest;
    const response = await callRestore(setup.env, {
      mode: "apply",
      snapshotKey,
      snapshotDigest: digest,
      currentEtag: "current-etag",
    });

    expect(response.status).toBe(502);
    expect(await readBody(response)).toMatchObject({ error: { code: "current_put_failed" } });
    expect(setup.calls).not.toContain("cache:delete:kf3-news");
  });

  it("applyはETag条件付きput成功後だけKVを削除する", async () => {
    const setup = createSetup();
    const canonical = await canonicalizeNewsDocument(snapshotDocument);
    const response = await callRestore(setup.env, {
      mode: "apply",
      snapshotKey,
      snapshotDigest: canonical.digest,
      currentEtag: "current-etag",
    });
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mode: "apply",
      previousCurrentEtag: "current-etag",
      updatedCurrentEtag: "updated-etag",
      writes: { r2Puts: 1, kvDeletes: 1 },
    });
    expect(setup.puts).toEqual([
      {
        key: CURRENT_ARCHIVE_KEY,
        value: canonical.normalizedJson,
        options: {
          onlyIf: { etagMatches: "current-etag" },
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        },
      },
    ]);
    expect(setup.calls).toEqual([
      `backup:get:${snapshotKey}`,
      `data:head:${CURRENT_ARCHIVE_KEY}`,
      `data:put:${CURRENT_ARCHIVE_KEY}`,
      "cache:delete:kf3-news",
    ]);
  });

  it("KV削除失敗時は更新済みETagを返す", async () => {
    const setup = createSetup({ cacheDeleteError: true });
    const digest = (await canonicalizeNewsDocument(snapshotDocument)).digest;
    const response = await callRestore(setup.env, {
      mode: "apply",
      snapshotKey,
      snapshotDigest: digest,
      currentEtag: "current-etag",
    });

    expect(response.status).toBe(502);
    expect(await readBody(response)).toMatchObject({
      error: { code: "cache_delete_failed", updatedEtag: "updated-etag" },
    });
  });
});
