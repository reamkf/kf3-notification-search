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
import { NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION } from "../news-archive-queue";
import { MIN_OFFICIAL_ENTRY_COUNT } from "../news-data";
import { createNewsCacheMetadata } from "../news-response-metadata";
import { createWorkerHandler } from "../server";
import {
  NEWS_REFRESH_CONTROL_KEY,
  NEWS_REFRESH_CONTROL_VERSION,
  NEWS_REFRESH_COOLDOWN_MS,
  NEWS_REFRESH_FINALIZATION_LEASE_MS,
  NEWS_REFRESH_LEASE_MS,
} from "../news-refresh-control";

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
type WorkerQueue = NonNullable<ReturnType<typeof createWorkerHandler>["queue"]>;

const callFetch = async (handler: ReturnType<typeof createWorkerHandler>, request: Request) =>
  (await handler.fetch?.(
    request as unknown as Parameters<WorkerFetch>[0],
    bindings as Parameters<WorkerFetch>[1],
    createExecutionContext() as unknown as Parameters<WorkerFetch>[2],
  )) as unknown as Response;

const callQueue = async (
  handler: ReturnType<typeof createWorkerHandler>,
  body: unknown = {
    version: NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION,
    reason: "refresh-detected-change",
    detectedAt: "2026-08-01T18:14:00.000Z",
    addedCount: MIN_OFFICIAL_ENTRY_COUNT - 1,
    updatedCount: 0,
    requiresInitialization: false,
  },
) => {
  const ack = vi.fn();
  const retry = vi.fn();
  await handler.queue?.(
    {
      queue: "kf3-notif-archive-update",
      messages: [
        {
          id: "message-1",
          timestamp: new Date("2026-08-01T18:15:00Z"),
          body,
          attempts: 1,
          ack,
          retry,
        },
      ],
    } as unknown as Parameters<WorkerQueue>[0],
    bindings as Parameters<WorkerQueue>[1],
    createExecutionContext() as unknown as Parameters<WorkerQueue>[2],
  );
  return { ack, retry };
};

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
      metadata: createNewsCacheMetadata(
        "archive-fallback",
        "2026-08-09T12:34:56.789Z",
        null,
        cached.length,
      ),
    });
    const fetcher = vi.fn(async () => Promise.reject(new Error("unexpected fetch")));
    const handler = createWorkerHandler({ fetcher });

    const response = await callFetch(handler, new Request("https://example.com/api/kf3-news"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
    expect(response.headers.get("X-KF3-News-Source")).toBe("archive-fallback");
    expect(response.headers.get("X-KF3-News-Official-Checked-At")).toBe("2026-08-09T12:34:56.789Z");
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

  it("Queue consumerが実R2のcurrentを更新してrefresh由来の実KVを維持する", async () => {
    await bindings.KF3_NOTIF_DATA.put(CURRENT_ARCHIVE_KEY, JSON.stringify(createDocument(1)));
    await bindings.KF3_NOTIF_CACHE.put("kf3-news", "fresh-refresh-cache");
    const officialDocument = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const logs: Record<string, unknown>[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => new Response(JSON.stringify(officialDocument)),
      clock: () => Date.parse("2026-08-01T18:15:00Z"),
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });

    const result = await callQueue(handler);

    expect(result.ack).toHaveBeenCalledOnce();
    expect(result.retry).not.toHaveBeenCalled();
    const current = await bindings.KF3_NOTIF_DATA.get(CURRENT_ARCHIVE_KEY);
    expect(JSON.parse((await current?.text()) ?? "").news).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(await bindings.KF3_NOTIF_CACHE.get("kf3-news")).toBe("fresh-refresh-cache");
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "news_archive_update", trigger: "queue" }),
    );
  });

  it("current初期化messageが実R2のlegacyからcurrentを作成する", async () => {
    const legacyDocument = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    await bindings.KF3_NOTIF_DATA.put(LEGACY_ARCHIVE_KEY, JSON.stringify(legacyDocument));
    await bindings.KF3_NOTIF_CACHE.put("kf3-news", "fresh-refresh-cache");
    const handler = createWorkerHandler({
      fetcher: async () => new Response(JSON.stringify(legacyDocument)),
      clock: () => Date.parse("2026-08-01T18:15:00Z"),
      logger,
    });

    const result = await callQueue(handler, {
      version: NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION,
      reason: "refresh-current-missing",
      detectedAt: "2026-08-01T18:14:00.000Z",
      addedCount: 0,
      updatedCount: 0,
      requiresInitialization: true,
    });

    expect(result.ack).toHaveBeenCalledOnce();
    expect(result.retry).not.toHaveBeenCalled();
    const current = await bindings.KF3_NOTIF_DATA.get(CURRENT_ARCHIVE_KEY);
    expect(JSON.parse((await current?.text()) ?? "").news).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(await bindings.KF3_NOTIF_CACHE.get("kf3-news")).toBe("fresh-refresh-cache");
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

  it("既存monthlyはHEADで確認してPUTしない", async () => {
    const nowMs = Date.parse("2026-08-01T18:15:00Z");
    const currentDocument = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const monthlyKey = buildBackupKeys(nowMs).monthlyKey;
    await bindings.KF3_NOTIF_DATA.put(CURRENT_ARCHIVE_KEY, JSON.stringify(currentDocument));
    await bindings.KF3_NOTIF_BACKUP.put(monthlyKey, "existing monthly");
    let putCalls = 0;
    const backupBucket = {
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        putCalls += 1;
        return bindings.KF3_NOTIF_BACKUP.put(...args);
      },
      head: bindings.KF3_NOTIF_BACKUP.head.bind(bindings.KF3_NOTIF_BACKUP),
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
    expect(putCalls).toBe(0);
    expect(await (await bindings.KF3_NOTIF_BACKUP.get(monthlyKey))?.text()).toBe(
      "existing monthly",
    );
  });

  it("DOの初回bootstrapで有効なR2 controlを引き継ぎ、以降はDO stateを使う", async () => {
    const nowMs = Date.parse("2026-08-09T12:00:00.000Z");
    const name = `bootstrap-${crypto.randomUUID()}`;
    const cooldownUntil = new Date(nowMs + NEWS_REFRESH_COOLDOWN_MS).toISOString();
    await bindings.KF3_NOTIF_DATA.put(
      NEWS_REFRESH_CONTROL_KEY,
      JSON.stringify({
        version: NEWS_REFRESH_CONTROL_VERSION,
        status: "cooldown",
        token: null,
        leaseUntil: null,
        cooldownUntil,
        lastOutcome: "success",
      }),
    );

    const coordinator = bindings.KF3_REFRESH_COORDINATOR.getByName(name);
    await expect(coordinator.acquire(nowMs)).resolves.toMatchObject({
      status: "cooldown",
      nextAvailableAt: cooldownUntil,
    });

    await bindings.KF3_NOTIF_DATA.put(
      NEWS_REFRESH_CONTROL_KEY,
      JSON.stringify({
        version: NEWS_REFRESH_CONTROL_VERSION,
        status: "idle",
        token: null,
        leaseUntil: null,
        cooldownUntil: null,
        lastOutcome: null,
      }),
    );
    await expect(coordinator.acquire(nowMs + 1)).resolves.toMatchObject({ status: "cooldown" });
  });

  it("同じDOへの同時acquireは一つだけ成功する", async () => {
    const coordinator = bindings.KF3_REFRESH_COORDINATOR.getByName(
      `concurrent-${crypto.randomUUID()}`,
    );
    const results = await Promise.all([coordinator.acquire(0), coordinator.acquire(0)]);

    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "running")).toHaveLength(1);
  });

  it("DOのrenewとcompleteはtokenを検証してcooldownへ遷移する", async () => {
    const nowMs = Date.parse("2026-08-09T12:00:00.000Z");
    const coordinator = bindings.KF3_REFRESH_COORDINATOR.getByName(
      `lifecycle-${crypto.randomUUID()}`,
    );
    const acquired = await coordinator.acquire(nowMs);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;

    const renewed = await coordinator.renew(
      acquired.lease.leaseToken,
      nowMs + 59_000,
      NEWS_REFRESH_FINALIZATION_LEASE_MS,
    );
    expect(renewed).toMatchObject({
      leaseToken: acquired.lease.leaseToken,
      leaseUntil: new Date(nowMs + 59_000 + NEWS_REFRESH_FINALIZATION_LEASE_MS).toISOString(),
    });
    expect(await coordinator.complete(acquired.lease.leaseToken, "success", nowMs + 59_001)).toBe(
      "updated",
    );
    expect(await coordinator.complete(acquired.lease.leaseToken, "failure", nowMs + 59_002)).toBe(
      "lease-mismatch",
    );
    expect(await coordinator.acquire(nowMs + 59_002)).toMatchObject({ status: "cooldown" });
  });

  it("refresh APIは実Durable Objectのcooldownを使う", async () => {
    const nowMs = Date.parse("2026-08-09T12:00:00.000Z");
    await bindings.KF3_NOTIF_DATA.put(CURRENT_ARCHIVE_KEY, JSON.stringify(createDocument(1)));
    const handler = createWorkerHandler({
      fetcher: async () => new Response(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT))),
      clock: () => nowMs,
      logger,
    });

    const first = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
    );
    const second = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe(String(NEWS_REFRESH_COOLDOWN_MS / 1000));
  });

  it("refresh APIは実Durable Objectのrunning leaseを202で返す", async () => {
    const nowMs = Date.parse("2026-08-09T12:00:00.000Z");
    await bindings.KF3_NOTIF_DATA.put(CURRENT_ARCHIVE_KEY, JSON.stringify(createDocument(1)));
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const handler = createWorkerHandler({
      fetcher: async () => {
        markFetchStarted();
        await release;
        return new Response(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT)));
      },
      clock: () => nowMs,
      logger,
    });

    const first = callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
    );
    await fetchStarted;
    const second = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
    );

    expect(second.status).toBe(202);
    releaseFetch();
    expect((await first).status).toBe(200);
  });

  it("期限切れleaseは再取得でき、期限境界のrenewとcompleteは拒否する", async () => {
    const nowMs = Date.parse("2026-08-09T12:00:00.000Z");
    const recoveryCoordinator = bindings.KF3_REFRESH_COORDINATOR.getByName(
      `recovery-${crypto.randomUUID()}`,
    );
    const first = await recoveryCoordinator.acquire(nowMs);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;

    const recovered = await recoveryCoordinator.acquire(nowMs + NEWS_REFRESH_LEASE_MS);
    expect(recovered.status).toBe("acquired");
    if (recovered.status === "acquired") {
      expect(recovered.lease.leaseToken).not.toBe(first.lease.leaseToken);
    }

    const boundaryCoordinator = bindings.KF3_REFRESH_COORDINATOR.getByName(
      `boundary-${crypto.randomUUID()}`,
    );
    const boundaryLease = await boundaryCoordinator.acquire(nowMs);
    expect(boundaryLease.status).toBe("acquired");
    if (boundaryLease.status !== "acquired") return;

    expect(
      await boundaryCoordinator.renew(
        boundaryLease.lease.leaseToken,
        nowMs + NEWS_REFRESH_LEASE_MS,
      ),
    ).toBe("inactive");
    expect(
      await boundaryCoordinator.complete(
        boundaryLease.lease.leaseToken,
        "success",
        nowMs + NEWS_REFRESH_LEASE_MS,
      ),
    ).toBe("lease-mismatch");
  });

  it("failure完了後はcooldownなしで再取得できる", async () => {
    const nowMs = Date.parse("2026-08-09T12:00:00.000Z");
    const coordinator = bindings.KF3_REFRESH_COORDINATOR.getByName(
      `failure-${crypto.randomUUID()}`,
    );
    const first = await coordinator.acquire(nowMs);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;

    expect(await coordinator.complete(first.lease.leaseToken, "failure", nowMs)).toBe("updated");
    expect(await coordinator.acquire(nowMs + 1)).toMatchObject({ status: "acquired" });
  });
});
