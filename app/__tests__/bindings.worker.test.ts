/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import type { ExportedHandler } from "@cloudflare/workers-types";
import { CURRENT_ARCHIVE_KEY, updateNewsArchive } from "../news-archive";
import { MIN_OFFICIAL_ENTRY_COUNT } from "../news-data";
import { createWorkerHandler } from "../server";

const bindings = env as unknown as WorkerBindings;

const createNews = (id: number) => ({
  id,
  targetUrl: `/info/${id}`,
  title: `ニュース${id}`,
  newsDate: "2026年08月01日 12時00分00秒",
  updated: "",
});

const createDocument = (count: number) => ({
  news: Array.from({ length: count }, (_, index) => createNews(index + 1)),
});

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
    await bindings.KF3_NOTIF_CACHE.put("kf3-news", JSON.stringify(cached));
    const fetcher = vi.fn(async () => Promise.reject(new Error("unexpected fetch")));
    const handler = createWorkerHandler({ fetcher });

    const response = await callFetch(handler, new Request("https://example.com/api/kf3-news"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
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
      logger: { log: () => undefined, error: () => undefined },
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
});
