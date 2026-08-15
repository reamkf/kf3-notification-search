/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import type { ExportedHandler } from "@cloudflare/workers-types";
import type { R2Bucket, R2PutOptions } from "@cloudflare/workers-types/experimental";
import {
  CURRENT_ARCHIVE_KEY,
  LEGACY_ARCHIVE_KEY,
  buildBackupKeys,
  updateNewsArchive,
} from "../news-archive";
import { MIN_OFFICIAL_ENTRY_COUNT } from "../news-data";
import { createNewsCacheMetadata } from "../news-response-metadata";
import { createWorkerHandler } from "../server";

const bindings = env as unknown as WorkerBindings;

const createNews = (id: number) => ({
  id,
  targetUrl: `/info/${id}`,
  title: `お知らせ${id}`,
  newsDate: "2026年08月01日 12時00分00秒",
  updated: "",
});

const createDocument = (count: number) => ({
  news: Array.from({ length: count }, (_, index) => createNews(index + 1)),
});

const createIfAbsentCondition = () => ({ etagDoesNotMatch: "*" });
const logger = { log: () => undefined, error: () => undefined };

type WorkerFetch = NonNullable<ExportedHandler<WorkerBindings>["fetch"]>;

const callFetch = async (handler: ReturnType<typeof createWorkerHandler>, request: Request) =>
  (await handler.fetch?.(
    request as unknown as Parameters<WorkerFetch>[0],
    bindings as Parameters<WorkerFetch>[1],
    createExecutionContext() as unknown as Parameters<WorkerFetch>[2],
  )) as unknown as Response;

beforeEach(async () => {
  await reset();
});

describe("Cloudflare bindings", () => {
  it("実KVのcache hitをWorker APIから返す", async () => {
    const cached = [
      {
        targetUrl: "/cached",
        title: "cache",
        newsDate: "2026年08月01日 12時00分00秒",
        updated: "",
      },
    ];
    await bindings.KF3_NOTIF_CACHE.put("kf3-news", JSON.stringify(cached), {
      metadata: createNewsCacheMetadata("archive-fallback", "2026-08-09T12:34:56.789Z"),
    });
    const fetcher = vi.fn(async () => Promise.reject(new Error("unexpected fetch")));
    const handler = createWorkerHandler({ fetcher });

    const response = await callFetch(handler, new Request("https://example.com/api/kf3-news"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
    expect(response.headers.get("X-KF3-News-Source")).toBe("archive-fallback");
    expect(response.headers.get("X-KF3-News-Fetched-At")).toBe("2026-08-09T12:34:56.789Z");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("実R2とKVでdaily、current、cache削除、monthlyを確定する", async () => {
    const currentDocument = createDocument(1);
    const currentText = `{ "news": ${JSON.stringify(currentDocument.news)} }`;
    await bindings.KF3_NOTIF_DATA.put(CURRENT_ARCHIVE_KEY, currentText);
    await bindings.KF3_NOTIF_CACHE.put("kf3-news", "stale");
    const officialDocument = createDocument(MIN_OFFICIAL_ENTRY_COUNT);

    const result = await updateNewsArchive({
      dataBucket: bindings.KF3_NOTIF_DATA,
      backupBucket: bindings.KF3_NOTIF_BACKUP,
      cache: bindings.KF3_NOTIF_CACHE,
      fetcher: async () => new Response(JSON.stringify(officialDocument)),
      nowMs: Date.parse("2026-08-01T18:15:00Z"),
      logger,
    });

    expect(result.updated).toBe(true);
    expect(result.dailyBackupKey).not.toBeNull();
    const daily = await bindings.KF3_NOTIF_BACKUP.get(result.dailyBackupKey!);
    expect(await daily?.text()).toBe(currentText);

    const current = await bindings.KF3_NOTIF_DATA.get(CURRENT_ARCHIVE_KEY);
    expect(current?.etag).toBe(result.updatedEtag);
    const currentJson = await current?.text();
    expect(JSON.parse(currentJson ?? "").news).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);

    expect(await bindings.KF3_NOTIF_CACHE.get("kf3-news")).toBeNull();
    const monthly = await bindings.KF3_NOTIF_BACKUP.get(result.monthlyBackupKey);
    expect(await monthly?.text()).toBe(currentJson);
  });

  it("実R2のIf-None-Match:*は既存objectを上書きしない", async () => {
    const key = "conditional/create-only.json";
    const first = await bindings.KF3_NOTIF_BACKUP.put(key, "first", {
      onlyIf: createIfAbsentCondition(),
    });
    const second = await bindings.KF3_NOTIF_BACKUP.put(key, "second", {
      onlyIf: createIfAbsentCondition(),
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await (await bindings.KF3_NOTIF_BACKUP.get(key))?.text()).toBe("first");
  });

  it("既存dailyを上書きせず、currentとKVを変更しない", async () => {
    const nowMs = Date.parse("2026-08-01T18:15:00Z");
    const currentDocument = createDocument(1);
    const currentText = JSON.stringify(currentDocument);
    const dailyKey = buildBackupKeys(nowMs).dailyKey;
    await bindings.KF3_NOTIF_DATA.put(CURRENT_ARCHIVE_KEY, currentText);
    await bindings.KF3_NOTIF_BACKUP.put(dailyKey, "existing daily");
    await bindings.KF3_NOTIF_CACHE.put("kf3-news", "stale");

    await expect(
      updateNewsArchive({
        dataBucket: bindings.KF3_NOTIF_DATA,
        backupBucket: bindings.KF3_NOTIF_BACKUP,
        cache: bindings.KF3_NOTIF_CACHE,
        fetcher: async () => new Response(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT))),
        nowMs,
        logger,
      }),
    ).rejects.toMatchObject({ stage: "daily-backup" });

    expect(await (await bindings.KF3_NOTIF_BACKUP.get(dailyKey))?.text()).toBe("existing daily");
    expect(await (await bindings.KF3_NOTIF_DATA.get(CURRENT_ARCHIVE_KEY))?.text()).toBe(
      currentText,
    );
    expect(await bindings.KF3_NOTIF_CACHE.get("kf3-news")).toBe("stale");
  });

  it("current初回作成の競合時は競合側を上書きしない", async () => {
    const nowMs = Date.parse("2026-08-01T18:15:00Z");
    const legacyDocument = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const concurrentText = JSON.stringify(createDocument(2));
    await bindings.KF3_NOTIF_DATA.put(LEGACY_ARCHIVE_KEY, JSON.stringify(legacyDocument));
    await bindings.KF3_NOTIF_CACHE.put("kf3-news", "stale");
    let injected = false;
    const dataBucket = {
      get: bindings.KF3_NOTIF_DATA.get.bind(bindings.KF3_NOTIF_DATA),
      head: bindings.KF3_NOTIF_DATA.head.bind(bindings.KF3_NOTIF_DATA),
      put: async (key: string, value: string, options?: R2PutOptions) => {
        if (key === CURRENT_ARCHIVE_KEY && !injected) {
          injected = true;
          await bindings.KF3_NOTIF_DATA.put(CURRENT_ARCHIVE_KEY, concurrentText);
        }
        return bindings.KF3_NOTIF_DATA.put(key, value, options);
      },
    } as unknown as R2Bucket;

    await expect(
      updateNewsArchive({
        dataBucket,
        backupBucket: bindings.KF3_NOTIF_BACKUP,
        cache: bindings.KF3_NOTIF_CACHE,
        fetcher: async () => new Response(JSON.stringify(legacyDocument)),
        nowMs,
        logger,
      }),
    ).rejects.toMatchObject({ stage: "etag-conflict" });

    expect(await (await bindings.KF3_NOTIF_DATA.get(CURRENT_ARCHIVE_KEY))?.text()).toBe(
      concurrentText,
    );
    expect(await bindings.KF3_NOTIF_CACHE.get("kf3-news")).toBe("stale");
    expect(await bindings.KF3_NOTIF_BACKUP.get(buildBackupKeys(nowMs).monthlyKey)).toBeNull();
  });

  it("既存monthlyはheadせず条件付きPUTだけでexistingにする", async () => {
    const nowMs = Date.parse("2026-08-01T18:15:00Z");
    const currentDocument = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const monthlyKey = buildBackupKeys(nowMs).monthlyKey;
    await bindings.KF3_NOTIF_DATA.put(CURRENT_ARCHIVE_KEY, JSON.stringify(currentDocument));
    await bindings.KF3_NOTIF_BACKUP.put(monthlyKey, "existing monthly");
    const backupBucket = {
      put: bindings.KF3_NOTIF_BACKUP.put.bind(bindings.KF3_NOTIF_BACKUP),
      head: async () => {
        throw new Error("head must not be called");
      },
    } as unknown as R2Bucket;

    const result = await updateNewsArchive({
      dataBucket: bindings.KF3_NOTIF_DATA,
      backupBucket,
      cache: bindings.KF3_NOTIF_CACHE,
      fetcher: async () => new Response(JSON.stringify(currentDocument)),
      nowMs,
      logger,
    });

    expect(result.updated).toBe(false);
    expect(result.monthlyBackupStatus).toBe("existing");
    expect(await (await bindings.KF3_NOTIF_BACKUP.get(monthlyKey))?.text()).toBe(
      "existing monthly",
    );
  });
});
