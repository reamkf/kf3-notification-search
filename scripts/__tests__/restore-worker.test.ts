import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type {
  KVNamespace,
  R2Bucket,
  R2Object,
  R2ObjectBody,
} from "@cloudflare/workers-types/experimental";
import { CURRENT_ARCHIVE_KEY } from "../../app/news-archive";
import {
  NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY,
  NEWS_CACHE_KEY,
  NEWS_REFRESH_STATE_KEY,
} from "../../app/news-cache-keys";
import { canonicalizeNewsDocument } from "../../app/news-data";
import { handleRestoreRequest, type RestoreBindings } from "../restore-worker";
import type { JsonInput, JsonObject } from "../../app/schema";

const snapshotKey = "daily/2026/08/02/2026-08-01T18-15-00Z-abc123def456.json";

const createNews = (id: number, newsDate = "2026年08月01日 12時00分00秒") => ({
  id,
  targetUrl: `/info/${id}`,
  title: `お知らせ${id}`,
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
  snapshot?: JsonInput;
  snapshotGetError?: boolean;
  snapshotMissing?: boolean;
  snapshotReadError?: boolean;
  currentEtag?: string | null;
  currentHeadError?: boolean;
  putResult?: "success" | "conflict" | "error";
  cacheDeleteError?: boolean;
};

const createSetup = (options: SetupOptions = {}) => {
  const calls: string[] = [];
  const puts: Array<{ key: string; value: string; options: JsonObject }> = [];
  const snapshot = options.snapshot ?? snapshotDocument;
  const currentEtag = options.currentEtag === undefined ? "current-etag" : options.currentEtag;
  const putResult = options.putResult ?? "success";

  // SAFETY: The fixture provides the R2 fields consumed by this test.
  const backupBucket = {
    get: async (key: string) => {
      calls.push(`backup:get:${key}`);
      if (options.snapshotGetError) throw new Error("snapshot get failed");
      if (options.snapshotMissing) return null;
      // SAFETY: The fixture provides the R2 body fields consumed by this test.
      return {
        text: async () => {
          if (options.snapshotReadError) throw new Error("snapshot read failed");
          const text = v.safeParse(v.string(), snapshot);
          return text.success ? text.output : JSON.stringify(snapshot);
        },
        // SAFETY: The fixture provides the R2 or KV fields consumed by this test.
      } /* SAFETY: The fixture provides the R2 or KV fields consumed by this test. */ as R2ObjectBody;
    },
    // SAFETY: The fixture provides the R2 or KV fields consumed by this test.
  } /* SAFETY: The fixture provides the R2 or KV fields consumed by this test. */ as R2Bucket;

  // SAFETY: The fixture provides the R2 fields consumed by this test.
  const dataBucket = {
    head: async (key: string) => {
      calls.push(`data:head:${key}`);
      if (options.currentHeadError) throw new Error("current head failed");
      // SAFETY: The fixture provides the R2 or KV fields consumed by this test.
      return currentEtag === null
        ? null
        : ({
            etag: currentEtag,
          } /* SAFETY: The fixture provides the R2 or KV fields consumed by this test. */ as R2Object);
    },
    put: async (key: string, value: string, putOptions: JsonObject) => {
      calls.push(`data:put:${key}`);
      puts.push({ key, value, options: putOptions });
      if (putResult === "error") throw new Error("put failed");
      if (putResult === "conflict") return null;
      // SAFETY: The fixture provides the R2 or KV fields consumed by this test.
      return {
        etag: "updated-etag",
      } /* SAFETY: The fixture provides the R2 or KV fields consumed by this test. */ as R2Object;
    },
    // SAFETY: The fixture provides the R2 or KV fields consumed by this test.
  } /* SAFETY: The fixture provides the R2 or KV fields consumed by this test. */ as R2Bucket;

  // SAFETY: The fixture provides the KV fields consumed by this test.
  const cache = {
    delete: async (key: string) => {
      calls.push(`cache:delete:${key}`);
      if (options.cacheDeleteError) throw new Error("delete failed");
    },
    // SAFETY: The fixture provides the R2 or KV fields consumed by this test.
  } /* SAFETY: The fixture provides the R2 or KV fields consumed by this test. */ as KVNamespace;

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

const callRestore = async (env: RestoreBindings, body: JsonInput) =>
  handleRestoreRequest(
    new Request("http://127.0.0.1:8790/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );

const readBody = async (response: Response): Promise<JsonInput> => response.json();

describe("operator-only復元tool", () => {
  beforeEach(() => {
    expect.hasAssertions();
  });

  it.each([
    {
      name: "localhost以外",
      request: new Request("https://example.com/restore", { method: "POST" }),
      status: 403,
      code: "localhost_only",
    },
    {
      name: "異なるpath",
      request: new Request("http://127.0.0.1:8790/other", { method: "POST" }),
      status: 404,
      code: "not_found",
    },
    {
      name: "POST以外",
      request: new Request("http://127.0.0.1:8790/restore"),
      status: 405,
      code: "method_not_allowed",
    },
  ])("$nameをR2アクセス前に拒否する", async ({ request, status, code }) => {
    const setup = createSetup();
    const response = await handleRestoreRequest(request, setup.env);

    expect(response.status).toBe(status);
    expect(await readBody(response)).toMatchObject({ error: { code } });
    expect(setup.calls).toEqual([]);
  });

  it.each([
    { name: "object以外", body: null, code: "invalid_request" },
    { name: "配列", body: [], code: "invalid_request" },
    {
      name: "不正mode",
      body: { mode: "force", snapshotKey },
      code: "invalid_mode",
    },
    {
      name: "不正snapshot key",
      body: { snapshotKey: "archive/current.json" },
      code: "invalid_snapshot_key",
    },
    {
      name: "数値digest",
      body: { snapshotKey, snapshotDigest: 1 },
      code: "invalid_snapshot_digest",
    },
    {
      name: "数値ETag",
      body: { snapshotKey, currentEtag: 1 },
      code: "invalid_current_etag",
    },
  ])("$nameのrequest bodyを拒否する", async ({ body, code }) => {
    const setup = createSetup();
    const response = await callRestore(setup.env, body);

    expect(response.status).toBe(400);
    expect(await readBody(response)).toMatchObject({ error: { code } });
    expect(setup.calls).toEqual([]);
  });

  it("不正JSONを拒否する", async () => {
    const setup = createSetup();
    const response = await handleRestoreRequest(
      new Request("http://127.0.0.1:8790/restore", {
        method: "POST",
        body: "{",
      }),
      setup.env,
    );

    expect(response.status).toBe(400);
    expect(await readBody(response)).toMatchObject({ error: { code: "invalid_json" } });
    expect(setup.calls).toEqual([]);
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

  it.each([
    {
      name: "snapshot取得失敗",
      options: { snapshotGetError: true },
      status: 502,
      code: "snapshot_read_failed",
    },
    {
      name: "snapshot欠落",
      options: { snapshotMissing: true },
      status: 404,
      code: "snapshot_not_found",
    },
    {
      name: "snapshot JSON不正",
      options: { snapshot: "not-json" },
      status: 422,
      code: "snapshot_json_invalid",
    },
    {
      name: "current取得失敗",
      options: { currentHeadError: true },
      status: 502,
      code: "current_read_failed",
    },
    {
      name: "current欠落",
      options: { currentEtag: null },
      status: 409,
      code: "current_not_found",
    },
  ] as const)("$nameを対応するR2エラーとして返す", async ({ options, status, code }) => {
    const setup = createSetup(options);
    const response = await callRestore(setup.env, { snapshotKey });

    expect(response.status).toBe(status);
    expect(await readBody(response)).toMatchObject({ error: { code } });
    expect(setup.puts).toHaveLength(0);
    expect(setup.calls).not.toContain("cache:delete:kf3-news");
  });

  it("applyの確認値が不足している場合はwriteを行わない", async () => {
    const setup = createSetup();
    const response = await callRestore(setup.env, {
      mode: "apply",
      snapshotKey,
    });

    expect(response.status).toBe(400);
    expect(await readBody(response)).toMatchObject({
      error: { code: "apply_confirmation_required" },
    });
    expect(setup.puts).toHaveLength(0);
    expect(setup.calls).not.toContain("cache:delete:kf3-news");
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
      writes: { r2Puts: 1, kvDeletes: 3 },
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
      `cache:delete:${NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY}`,
      `cache:delete:${NEWS_CACHE_KEY}`,
      `cache:delete:${NEWS_REFRESH_STATE_KEY}`,
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
    expect(setup.calls).toEqual([
      `backup:get:${snapshotKey}`,
      `data:head:${CURRENT_ARCHIVE_KEY}`,
      `data:put:${CURRENT_ARCHIVE_KEY}`,
      `cache:delete:${NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY}`,
      `cache:delete:${NEWS_CACHE_KEY}`,
      `cache:delete:${NEWS_REFRESH_STATE_KEY}`,
    ]);
  });
});
