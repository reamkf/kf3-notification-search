import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionContext,
  Fetcher,
  KVNamespace,
  Queue,
  R2Bucket,
  R2Object,
  R2ObjectBody,
} from "@cloudflare/workers-types/experimental";
import {
  CURRENT_ARCHIVE_KEY,
  LEGACY_ARCHIVE_KEY,
  OFFICIAL_CHECK_STATE_KEY,
  OFFICIAL_FETCH_STATE_KEY,
  type NewsArchiveUpdateDependencies,
} from "../news-archive";
import {
  NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION,
  type NewsArchiveUpdateMessage,
} from "../news-archive-queue";
import {
  NEWS_REFRESH_LEASE_MS,
  type NewsRefreshAcquireResult,
  type NewsRefreshCompletionResult,
  type NewsRefreshRenewalResult,
} from "../news-refresh-control";
import { NEWS_CACHE_KEY, NEWS_REFRESH_STATE_KEY } from "../news-cache-keys";
import { MIN_OFFICIAL_ENTRY_COUNT } from "../news-data";
import { createWorkerHandler } from "../server";
import { bridgeRuntimeValue } from "../runtime-value";
import { createNewsCacheMetadata } from "../news-response-metadata";
import type { JsonInput, JsonObject } from "../schema";

const createNews = (id: number, category?: string) => {
  const news = {
    id,
    targetUrl: `/info/${id}`,
    title: `お知らせ${id}`,
    newsDate: "2026年08月01日 12時00分00秒",
    updated: "2026年08月01日 12時00分00秒",
  };
  if (category !== undefined) return { ...news, category };
  return news;
};

const createDocument = (count: number, sorted = false) => {
  const news = Array.from({ length: count }, (_, index) => createNews(index + 1));
  if (sorted) news.reverse();
  return { news };
};

// SAFETY: The fixture provides the R2 object fields consumed by this test.
const createR2Object = (text: string, etag = "etag"): R2ObjectBody =>
  ({
    etag,
    httpEtag: `"${etag}"`,
    text: async () => text,
    get body() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    },
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    // SAFETY: The fixture provides the Worker fields consumed by this test.
  }) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as R2ObjectBody;

const createResponse = (document: JsonInput, ok = true) =>
  new Response(ok ? JSON.stringify(document) : "failed", { status: ok ? 200 : 503 });

type RefreshCoordinatorStub = {
  acquire(nowMs: number): Promise<NewsRefreshAcquireResult>;
  renew(token: string, nowMs: number, leaseMs?: number): Promise<NewsRefreshRenewalResult>;
  complete(
    token: string,
    outcome: "success" | "failure",
    nowMs: number,
  ): Promise<NewsRefreshCompletionResult>;
};

type TestBindings = {
  env: WorkerBindings;
  dataGets: string[];
  getCurrentHeadCalls: () => number;
  cacheValues: Map<string, string>;
  cacheMetadata: Map<string, unknown>;
  cachePuts: Array<{
    key: string;
    value: string;
    expirationTtl?: number;
    metadata?: unknown;
  }>;
  cacheDeletes: string[];
  queueMessages: NewsArchiveUpdateMessage[];
  refreshCoordinator: RefreshCoordinatorStub;
};

type BindingOptions = {
  cacheGetError?: boolean;
  cachePutError?: boolean;
  queueSendError?: boolean;
  queueSendBlock?: Promise<void>;
  legacyMissing?: boolean;
  stateText?: string;
  stateEtag?: string;
  checkStateText?: string;
  checkStateEtag?: string;
  checkStatePutBlock?: Promise<void>;
  conditionalCurrentMismatch?: boolean;
  conditionalCurrentReadMismatch?: boolean;
  currentChangesOnCachePut?: boolean;
  cachePutBlock?: Promise<void>;
  refreshRenewResult?: NewsRefreshRenewalResult;
  refreshCompleteResult?: NewsRefreshCompletionResult;
  refreshCompleteError?: Error;
  refreshCompleteBeforeResult?: () => void;
};

const createRefreshCoordinator = (options: BindingOptions): RefreshCoordinatorStub => {
  const token = crypto.randomUUID();
  return {
    acquire: async (nowMs) => ({
      status: "acquired",
      lease: {
        leaseToken: token,
        leaseUntil: new Date(nowMs + NEWS_REFRESH_LEASE_MS).toISOString(),
      },
    }),
    renew: async (leaseToken, nowMs, leaseMs = NEWS_REFRESH_LEASE_MS) =>
      options.refreshRenewResult ?? {
        leaseToken,
        leaseUntil: new Date(nowMs + leaseMs).toISOString(),
      },
    complete: async () => {
      options.refreshCompleteBeforeResult?.();
      if (options.refreshCompleteError) throw options.refreshCompleteError;
      return options.refreshCompleteResult ?? "updated";
    },
  };
};

const createBindings = (
  currentText: string | null,
  legacyText = JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT, true)),
  options: BindingOptions = {},
): TestBindings => {
  const dataGets: string[] = [];
  let currentHeadCalls = 0;
  let currentEtag = "current-etag";
  let checkStateText = options.checkStateText ?? null;
  let checkStateEtag = options.checkStateEtag ?? "check-state-etag-0";
  const cacheValues = new Map<string, string>();
  const cacheMetadata = new Map<string, unknown>();
  const cachePuts: Array<{
    key: string;
    value: string;
    expirationTtl?: number;
    metadata?: unknown;
  }> = [];
  const cacheDeletes: string[] = [];
  const queueMessages: NewsArchiveUpdateMessage[] = [];
  // SAFETY: The test double implements the R2 methods exercised by this scenario.
  const dataBucket = {
    get: async (key: string, getOptions?: { onlyIf?: { etagMatches?: string } }) => {
      dataGets.push(key);
      if (
        key === CURRENT_ARCHIVE_KEY &&
        getOptions?.onlyIf?.etagMatches !== undefined &&
        (options.conditionalCurrentMismatch || options.conditionalCurrentReadMismatch)
      ) {
        // SAFETY: The test double returns the R2 metadata fields used by the handler.
        return { etag: "new-current-etag" } as R2Object;
      }
      if (key === CURRENT_ARCHIVE_KEY && currentText !== null)
        return createR2Object(currentText, currentEtag);
      if (key === LEGACY_ARCHIVE_KEY && !options.legacyMissing)
        return createR2Object(legacyText, "legacy-etag");
      if (key === OFFICIAL_FETCH_STATE_KEY && options.stateText !== undefined)
        return createR2Object(options.stateText, options.stateEtag ?? "state-etag");
      if (key === OFFICIAL_CHECK_STATE_KEY && checkStateText !== null)
        return createR2Object(checkStateText, checkStateEtag);
      return null;
    },
    head: async (key: string) => {
      if (key === CURRENT_ARCHIVE_KEY && currentText !== null) {
        currentHeadCalls += 1;
        // SAFETY: The test double returns the R2 metadata fields used by the handler.
        return {
          etag: options.conditionalCurrentMismatch ? "new-current-etag" : currentEtag,
        } as R2Object;
      }
      return null;
    },
    put: async (key: string, value: string) => {
      if (key === OFFICIAL_CHECK_STATE_KEY) {
        if (options.checkStatePutBlock) await options.checkStatePutBlock;
        checkStateText = value;
        checkStateEtag = `check-state-etag-${checkStateText.length}`;
        // SAFETY: The test double returns the R2 metadata fields used by the handler.
        return { etag: checkStateEtag } as R2Object;
      }
      return null;
    },
    // SAFETY: The fixture provides the Worker fields consumed by this test.
  } /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as R2Bucket;
  // SAFETY: The test double implements the KV methods exercised by this scenario.
  const cache = {
    get: async (key: string) => {
      if (options.cacheGetError) throw new Error("cache get failed");
      return cacheValues.get(key) ?? null;
    },
    getWithMetadata: async (key: string) => {
      if (options.cacheGetError) throw new Error("cache get failed");
      return {
        value: cacheValues.get(key) ?? null,
        metadata: cacheMetadata.get(key) ?? null,
        cacheStatus: null,
      };
    },
    put: async (
      key: string,
      value: string,
      putOptions: { expirationTtl?: number; metadata?: unknown },
    ) => {
      if (options.cachePutError) throw new Error("cache put failed");
      if (options.cachePutBlock) await options.cachePutBlock;
      cacheValues.set(key, value);
      if (putOptions.metadata === undefined) cacheMetadata.delete(key);
      else cacheMetadata.set(key, putOptions.metadata);
      cachePuts.push({
        key,
        value,
        expirationTtl: putOptions.expirationTtl,
        metadata: putOptions.metadata,
      });
      if (options.currentChangesOnCachePut && key !== NEWS_REFRESH_STATE_KEY) {
        currentEtag = "changed-current-etag";
      }
    },
    delete: async (key: string) => {
      cacheDeletes.push(key);
      cacheValues.delete(key);
      cacheMetadata.delete(key);
    },
    // SAFETY: The fixture provides the Worker fields consumed by this test.
  } /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as KVNamespace;
  const backup = bridgeRuntimeValue<R2Bucket>({
    get: async () => null,
    head: async () => null,
    put: async () => null,
  });
  const archiveUpdateQueue = bridgeRuntimeValue<Queue<NewsArchiveUpdateMessage>>({
    send: async (message: NewsArchiveUpdateMessage) => {
      if (options.queueSendError) throw new Error("queue send failed");
      if (options.queueSendBlock) await options.queueSendBlock;
      queueMessages.push(message);
    },
  });
  const refreshCoordinator = createRefreshCoordinator(options);
  const refreshCoordinatorNamespace = bridgeRuntimeValue<WorkerBindings["KF3_REFRESH_COORDINATOR"]>(
    {
      getByName: () => refreshCoordinator,
    },
  );
  return {
    env: {
      // SAFETY: The fixture provides the Worker fields consumed by this test.
      ASSETS:
        {} /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as Fetcher,
      KF3_NOTIF_CACHE: cache,
      KF3_NOTIF_DATA: dataBucket,
      KF3_NOTIF_BACKUP: backup,
      KF3_ARCHIVE_UPDATE_QUEUE: archiveUpdateQueue,
      KF3_REFRESH_COORDINATOR: refreshCoordinatorNamespace,
    },
    dataGets,
    getCurrentHeadCalls: () => currentHeadCalls,
    cacheValues,
    cacheMetadata,
    cachePuts,
    cacheDeletes,
    queueMessages,
    refreshCoordinator,
  };
};

// SAFETY: The test context implements the execution hooks exercised by this test.
const createContext = (pending?: Promise<unknown>[]) =>
  ({
    waitUntil: (promise: Promise<unknown>) => {
      pending?.push(promise);
    },
    passThroughOnException: () => undefined,
    // SAFETY: The fixture provides the Worker fields consumed by this test.
  }) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as ExecutionContext;

type WorkerFetch = NonNullable<ReturnType<typeof createWorkerHandler>["fetch"]>;
type WorkerScheduled = NonNullable<ReturnType<typeof createWorkerHandler>["scheduled"]>;
type WorkerQueue = NonNullable<ReturnType<typeof createWorkerHandler>["queue"]>;

const callFetch = async (
  handler: ReturnType<typeof createWorkerHandler>,
  request: Request,
  env: WorkerBindings,
  pending?: Promise<unknown>[],
) =>
  // SAFETY: The test invokes the Worker fetch adapter with compatible runtime values.
  (await handler.fetch?.(
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    bridgeRuntimeValue<Parameters<WorkerFetch>[0]>(request),
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    env /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as Parameters<WorkerFetch>[1],
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    createContext(
      pending,
    ) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as Parameters<WorkerFetch>[2],
    // SAFETY: The fixture provides the Worker fields consumed by this test.
  )) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as Response;

const callScheduled = async (
  handler: ReturnType<typeof createWorkerHandler>,
  env: WorkerBindings,
  scheduledTime: number,
) =>
  // SAFETY: The test invokes the Worker scheduled adapter with compatible runtime values.
  handler.scheduled?.(
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    {
      scheduledTime,
    } /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as Parameters<WorkerScheduled>[0],
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    env /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as Parameters<WorkerScheduled>[1],
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    createContext() /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as Parameters<WorkerScheduled>[2],
  );

const callQueue = async (
  handler: ReturnType<typeof createWorkerHandler>,
  env: WorkerBindings,
  body: JsonInput,
) => {
  const ack = vi.fn();
  const retry = vi.fn();
  // SAFETY: The test invokes the Worker queue adapter with compatible runtime values.
  await handler.queue?.(
    bridgeRuntimeValue<Parameters<WorkerQueue>[0]>({
      queue: "kf3-notif-archive-update",
      messages: [
        {
          id: "message-1",
          timestamp: new Date("2026-08-09T12:34:56.789Z"),
          body,
          attempts: 1,
          ack,
          retry,
        },
      ],
    }),
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    env /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as Parameters<WorkerQueue>[1],
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    createContext() /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as Parameters<WorkerQueue>[2],
  );
  return { ack, retry };
};

describe("Worker API handler", () => {
  it("有効cacheはトップレベル配列を返し、外部I/Oを行わない", async () => {
    const setup = createBindings(null);
    const cached = [
      {
        targetUrl: "/cached",
        title: "cache",
        newsDate: "2026年08月01日 12時00分00秒",
        updated: "now",
      },
    ];
    setup.cacheValues.set("kf3-news", JSON.stringify(cached));
    setup.cacheMetadata.set("kf3-news", {
      ...createNewsCacheMetadata("archive-fallback", "2026-08-09T12:34:56.789Z"),
      refreshAvailableAt: "2026-08-09T12:39:56.789Z",
    });
    setup.env.CF_VERSION_METADATA = {
      id: "version-1",
      tag: "test",
      timestamp: "2026-08-09T12:34:56.789Z",
    };
    const logs: JsonObject[] = [];
    let fetchCalls = 0;
    let clockCalls = 0;
    const handler = createWorkerHandler({
      fetcher: async () => {
        fetchCalls += 1;
        return createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT));
      },
      clock: () => {
        clockCalls += 1;
        return Date.now();
      },
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
    expect(response.headers.get("X-KF3-News-Source")).toBe("archive-fallback");
    expect(response.headers.get("X-KF3-News-Official-Checked-At")).toBe("2026-08-09T12:34:56.789Z");
    expect(setup.dataGets).toEqual([]);
    expect(fetchCalls).toBe(0);
    expect(clockCalls).toBe(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_api_succeeded",
        dataSource: "merged-kv",
        workerVersionId: "version-1",
        primaryCacheReadDurationMs: expect.any(Number),
        snapshotCacheReadDurationMs: 0,
        archiveReadDurationMs: 0,
        officialCheckStateReadDurationMs: 0,
        totalDurationMs: expect.any(Number),
      }),
    );
  });

  it("refresh state KVは本文とETagが一致するとGET metadataへ反映する", async () => {
    const setup = createBindings(null);
    setup.cacheValues.set("kf3-news", "cached-json");
    setup.cacheMetadata.set(
      NEWS_CACHE_KEY,
      createNewsCacheMetadata("merged", null, "current-etag", 1),
    );
    setup.cacheValues.set(
      NEWS_REFRESH_STATE_KEY,
      JSON.stringify({
        version: 1,
        baseArchiveEtag: "current-etag",
        officialCheckedAt: "2026-08-09T12:34:56.789Z",
        refreshAvailableAt: "2026-08-09T12:39:56.789Z",
      }),
    );

    const response = await callFetch(
      createWorkerHandler(),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-KF3-News-Official-Checked-At")).toBe("2026-08-09T12:34:56.789Z");
    expect(response.headers.get("X-KF3-News-Refresh-Available-At")).toBe(
      "2026-08-09T12:39:56.789Z",
    );
    expect(setup.dataGets).toEqual([]);
  });

  it("cacheは再検証せずそのまま返す", async () => {
    const setup = createBindings(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT, true)));
    setup.cacheValues.set("kf3-news", "not-json");
    let fetchCalls = 0;
    const handler = createWorkerHandler({
      fetcher: async () => {
        fetchCalls += 1;
        return createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT));
      },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("not-json");
    expect(response.headers.get("X-KF3-News-Source")).toBe("unknown");
    expect(response.headers.get("X-KF3-News-Official-Checked-At")).toBeNull();
    expect(fetchCalls).toBe(0);
    expect(setup.dataGets).toEqual([]);
    expect(setup.cacheDeletes).toEqual([]);
    expect(setup.cachePuts).toEqual([]);
  });

  it("cache missでは保存済み公式確認時刻でarchive snapshotをwrite-throughする", async () => {
    const officialCheckedAt = "2026-08-09T12:34:56.789Z";
    const setup = createBindings(JSON.stringify(createDocument(2)), undefined, {
      checkStateText: JSON.stringify({ version: 1, checkedAt: officialCheckedAt }),
    });
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => {
        throw new Error("unexpected fetch");
      },
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });
    const pending: Promise<unknown>[] = [];
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
      pending,
    );
    const responseText = await response.text();
    await Promise.all(pending);
    // SAFETY: The endpoint returns a JSON array of client news records.
    const body = JSON.parse(
      responseText,
    ) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as JsonObject[];

    expect(response.status).toBe(200);
    expect(body[0].targetUrl).toBe("/info/1");
    expect(body[1].targetUrl).toBe("/info/2");
    expect(body).toHaveLength(2);
    expect(response.headers.get("X-KF3-News-Source")).toBe("archive-snapshot");
    expect(response.headers.get("X-KF3-News-Official-Checked-At")).toBe("2026-08-09T12:34:56.789Z");
    expect(response.headers.get("X-KF3-News-Data-Version")).toBe("current-etag");
    expect(setup.cachePuts).toHaveLength(1);
    expect(setup.cachePuts[0]).toMatchObject({
      key: "kf3-news-archive-snapshot",
      value: responseText,
      expirationTtl: 86400,
      metadata: {
        version: 2,
        source: "archive-snapshot",
        officialCheckedAt: "2026-08-09T12:34:56.789Z",
        baseArchiveEtag: "current-etag",
        newsCount: 2,
      },
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_api_succeeded",
        dataSource: "r2",
        primaryCacheReadDurationMs: expect.any(Number),
        snapshotCacheReadDurationMs: expect.any(Number),
        archiveReadDurationMs: expect.any(Number),
        officialCheckStateReadDurationMs: expect.any(Number),
        totalDurationMs: expect.any(Number),
      }),
    );
  });

  it("snapshot cache maintenanceはレスポンスを待たせない", async () => {
    let releasePut!: () => void;
    const cachePutBlock = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      cachePutBlock,
    });
    const pending: Promise<unknown>[] = [];
    const response = await callFetch(
      createWorkerHandler(),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
      pending,
    );

    expect(response.status).toBe(200);
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    expect(
      (await response.json()) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as unknown[],
    ).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(setup.cachePuts).toHaveLength(0);

    releasePut();
    await Promise.all(pending);
    expect(setup.cachePuts).toHaveLength(1);
  });

  it("snapshot保存後にcurrentが変わった場合はsnapshotを削除する", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      currentChangesOnCachePut: true,
    });
    const pending: Promise<unknown>[] = [];
    const response = await callFetch(
      createWorkerHandler(),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
      pending,
    );
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(setup.cacheDeletes).toContain("kf3-news-archive-snapshot");
    expect(setup.cacheValues.get("kf3-news-archive-snapshot")).toBeUndefined();
  });

  it("merged cacheをarchive snapshot cacheより優先する", async () => {
    const setup = createBindings(null);
    setup.cacheValues.set("kf3-news", "merged-json");
    setup.cacheValues.set("kf3-news-archive-snapshot", "archive-json");

    const response = await callFetch(
      createWorkerHandler(),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("merged-json");
    expect(setup.dataGets).toEqual([]);
    expect(setup.cachePuts).toEqual([]);
  });

  it("archive snapshot cache hitはR2へアクセスせず返す", async () => {
    const setup = createBindings(null);
    setup.cacheValues.set("kf3-news-archive-snapshot", "archive-json");
    setup.cacheMetadata.set(
      "kf3-news-archive-snapshot",
      createNewsCacheMetadata("archive-snapshot", "2026-08-09T12:34:56.789Z", null, 1),
    );
    const logs: JsonObject[] = [];

    const response = await callFetch(
      createWorkerHandler({
        logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
      }),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("archive-json");
    expect(setup.dataGets).toEqual([]);
    expect(setup.cachePuts).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_api_succeeded",
        dataSource: "snapshot-kv",
        primaryCacheReadDurationMs: expect.any(Number),
        snapshotCacheReadDurationMs: expect.any(Number),
        archiveReadDurationMs: 0,
        officialCheckStateReadDurationMs: 0,
        totalDurationMs: expect.any(Number),
      }),
    );
  });

  it("snapshot KV hitでも対応するrefresh stateをmetadataへ反映する", async () => {
    const setup = createBindings(null);
    setup.cacheValues.set("kf3-news-archive-snapshot", "archive-json");
    setup.cacheMetadata.set(
      "kf3-news-archive-snapshot",
      createNewsCacheMetadata("archive-snapshot", "2026-08-09T12:00:00.000Z", "current-etag", 1),
    );
    setup.cacheValues.set(
      NEWS_REFRESH_STATE_KEY,
      JSON.stringify({
        version: 1,
        baseArchiveEtag: "current-etag",
        officialCheckedAt: "2026-08-09T12:34:56.789Z",
        refreshAvailableAt: "2026-08-09T12:39:56.789Z",
      }),
    );

    const response = await callFetch(
      createWorkerHandler(),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("archive-json");
    expect(response.headers.get("X-KF3-News-Official-Checked-At")).toBe("2026-08-09T12:34:56.789Z");
    expect(response.headers.get("X-KF3-News-Refresh-Available-At")).toBe(
      "2026-08-09T12:39:56.789Z",
    );
    expect(setup.dataGets).toEqual([]);
  });

  it("R2 fallbackでも対応するrefresh stateをmetadataへ反映する", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      checkStateText: JSON.stringify({ version: 1, checkedAt: "2026-08-09T12:00:00.000Z" }),
    });
    setup.cacheValues.set(
      NEWS_REFRESH_STATE_KEY,
      JSON.stringify({
        version: 1,
        baseArchiveEtag: "current-etag",
        officialCheckedAt: "2026-08-09T12:34:56.789Z",
        refreshAvailableAt: "2026-08-09T12:39:56.789Z",
      }),
    );
    const pending: Promise<unknown>[] = [];

    const response = await callFetch(
      createWorkerHandler(),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
      pending,
    );
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-KF3-News-Official-Checked-At")).toBe("2026-08-09T12:34:56.789Z");
    expect(response.headers.get("X-KF3-News-Refresh-Available-At")).toBe(
      "2026-08-09T12:39:56.789Z",
    );
    expect(setup.cachePuts[0].metadata).toMatchObject({
      officialCheckedAt: "2026-08-09T12:34:56.789Z",
      refreshAvailableAt: "2026-08-09T12:39:56.789Z",
    });
  });

  it("cache missのKV write失敗でもHTTP 200を維持する", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      cachePutError: true,
    });
    const logs: JsonObject[] = [];
    const pending: Promise<unknown>[] = [];
    const response = await callFetch(
      createWorkerHandler({
        logger: { log: () => undefined, error: (event) => logs.push(event) },
      }),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
      pending,
    );

    expect(response.status).toBe(200);
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    expect(
      (await response.json()) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as unknown[],
    ).toHaveLength(1);
    await Promise.all(pending);
    expect(setup.cachePuts).toHaveLength(0);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "news_api_cache_write_failed", archiveCount: 1 }),
    );
    expect(logs).not.toContainEqual(expect.objectContaining({ event: "news_api_error" }));
  });

  it("cache missではrefresh制御metadataへアクセスしない", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)));
    const pending: Promise<unknown>[] = [];
    const response = await callFetch(
      createWorkerHandler(),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
      pending,
    );
    await Promise.all(pending);
    expect(response.status).toBe(200);
    expect(setup.dataGets).not.toContain("control/news-refresh.json");
    expect(setup.cachePuts).toHaveLength(1);
  });

  it("cache missでは公式取得せずcurrent snapshotを返す", async () => {
    const current = JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT, true));
    const setup = createBindings(current, undefined, {
      stateText: JSON.stringify({
        version: 1,
        officialEtag: '"official-etag"',
        currentEtag: "current-etag",
      }),
    });
    const requestHeaders: Headers[] = [];
    const handler = createWorkerHandler({
      fetcher: async (_input, init) => {
        requestHeaders.push(new Headers(init?.headers));
        return new Response(null, { status: 304, headers: { etag: '"official-etag"' } });
      },
      clock: () => Date.parse("2026-08-09T12:34:56.789Z"),
    });
    const pending: Promise<unknown>[] = [];
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
      pending,
    );
    expect(response.status).toBe(200);
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    expect(
      (await response.json()) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as unknown[],
    ).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    await Promise.all(pending);
    expect(requestHeaders).toHaveLength(0);
    expect(setup.cachePuts).toHaveLength(1);
  });

  it("公式取得とcurrent読み込みが両方失敗した場合はarchive-readを優先する", async () => {
    const setup = createBindings("invalid", undefined, {
      stateText: JSON.stringify({
        version: 1,
        officialEtag: '"official-etag"',
        currentEtag: "current-etag",
      }),
    });
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => Promise.reject(new Error("official unavailable")),
      logger: { log: () => undefined, error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(response.status).toBe(500);
    expect(logs[0]).toMatchObject({
      event: "news_api_error",
      stage: "archive-read",
    });
  });

  it("cache読み込み失敗時は外部I/Oへ進まず5xxにする", async () => {
    const setup = createBindings(null, JSON.stringify(createDocument(1)), {
      cacheGetError: true,
    });
    const logs: JsonObject[] = [];
    let fetchCalls = 0;
    const handler = createWorkerHandler({
      fetcher: async () => {
        fetchCalls += 1;
        return createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT));
      },
      logger: { log: () => undefined, error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );

    expect(response.status).toBe(500);
    expect(setup.dataGets).toEqual([]);
    expect(fetchCalls).toBe(0);
    expect(setup.cachePuts).toEqual([]);
    expect(logs[0]).toMatchObject({
      event: "news_api_error",
      stage: "unknown",
      archiveCount: null,
    });
  });

  it("GETのarchive snapshot失敗時は公式を使わず5xxにする", async () => {
    const setup = createBindings("invalid");
    let fetchCalls = 0;
    const handler = createWorkerHandler({
      fetcher: async () => {
        fetchCalls += 1;
        return createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT));
      },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(response.status).toBe(500);
    expect(fetchCalls).toBe(0);
    expect(setup.cachePuts).toHaveLength(0);
  });

  it("refresh成功時は公式とのmerge結果をKVへ保存しmetadata付きで返す", async () => {
    const archive = createDocument(1, true);
    const official = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    official.news[0] = { ...official.news[0], category: "refresh" };
    const setup = createBindings(JSON.stringify(archive));
    setup.env.CF_VERSION_METADATA = {
      id: "version-refresh",
      tag: "test-refresh",
      timestamp: "2026-08-09T12:34:56.789Z",
    };
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(official),
      clock: () => Date.parse("2026-08-09T12:34:56.789Z"),
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );
    // SAFETY: This response is the successful refresh payload used by the test.
    const payload =
      (await response.json()) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as {
        news: JsonObject[];
        metadata: JsonInput;
      };

    expect(response.status).toBe(200);
    expect(payload.news).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(payload.news[0].category).toBe("refresh");
    expect(payload.metadata).toEqual({
      ...createNewsCacheMetadata(
        "merged",
        "2026-08-09T12:34:56.789Z",
        null,
        MIN_OFFICIAL_ENTRY_COUNT,
      ),
      fetchedAt: "2026-08-09T12:34:56.789Z",
      refreshAvailableAt: "2026-08-09T12:39:56.789Z",
    });
    expect(response.headers.get("X-KF3-News-Source")).toBe("merged");
    expect(response.headers.get("X-KF3-News-Official-Checked-At")).toBe("2026-08-09T12:34:56.789Z");
    expect(response.headers.get("X-KF3-News-Refresh-Available-At")).toBe(
      "2026-08-09T12:39:56.789Z",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(setup.cachePuts).toHaveLength(2);
    expect(setup.cachePuts[0]).toMatchObject({
      key: NEWS_CACHE_KEY,
      expirationTtl: 86400,
      metadata: createNewsCacheMetadata("merged", null, null, MIN_OFFICIAL_ENTRY_COUNT),
    });
    expect(setup.cachePuts[1]).toMatchObject({
      key: NEWS_REFRESH_STATE_KEY,
      expirationTtl: 86400,
      metadata: undefined,
    });
    expect(JSON.parse(setup.cachePuts[1].value)).toEqual({
      version: 1,
      baseArchiveEtag: null,
      officialCheckedAt: "2026-08-09T12:34:56.789Z",
      refreshAvailableAt: "2026-08-09T12:39:56.789Z",
    });
    const cachedGetResponse = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(cachedGetResponse.headers.get("X-KF3-News-Refresh-Available-At")).toBe(
      "2026-08-09T12:39:56.789Z",
    );
    expect(JSON.parse(setup.cacheValues.get("kf3-news") ?? "null")).toEqual(payload.news);
    expect(setup.cacheValues.get("kf3-news")).toBe(JSON.stringify(payload.news));
    expect(setup.queueMessages).toEqual([
      {
        version: NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION,
        reason: "refresh-detected-change",
        detectedAt: "2026-08-09T12:34:56.789Z",
        addedCount: MIN_OFFICIAL_ENTRY_COUNT - 1,
        updatedCount: 1,
        requiresInitialization: false,
      },
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_refresh_succeeded",
        workerVersionId: "version-refresh",
        archiveCount: MIN_OFFICIAL_ENTRY_COUNT,
        addedCount: MIN_OFFICIAL_ENTRY_COUNT - 1,
        updatedCount: 1,
        requiresInitialization: false,
        archiveChanged: true,
        archiveUpdateNeeded: true,
        archiveUpdateQueueStatus: "scheduled",
        officialFetchCount: 1,
        officialFetchStatus: "modified",
        refreshDataSource: "full-merge",
        refreshLeaseAcquireDurationMs: expect.any(Number),
        refreshEligibilityDurationMs: expect.any(Number),
        refreshFetchDurationMs: expect.any(Number),
        officialFetchDurationMs: expect.any(Number),
        refreshCacheReadDurationMs: expect.any(Number),
        archiveReadDurationMs: expect.any(Number),
        cachePutDurationMs: expect.any(Number),
        currentEtagCheckDurationMs: expect.any(Number),
        leaseCompletionDurationMs: expect.any(Number),
        refreshFinalizationDurationMs: expect.any(Number),
        refreshTotalDurationMs: expect.any(Number),
      }),
    );
  });

  it("refresh処理が遅延しても公式確認日時を応答時刻で上書きしない", async () => {
    const baseTime = Date.parse("2026-08-09T12:00:00.000Z");
    const officialCheckedAt = new Date(baseTime + 10_000).toISOString();
    const refreshAvailableAt = new Date(baseTime + 20_000 + 5 * 60_000).toISOString();
    const clockValues = [baseTime, baseTime + 10_000, baseTime + 12_000, baseTime + 20_000];
    const setup = createBindings(JSON.stringify(createDocument(1)));
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT));
        },
        clock: () => clockValues.shift() ?? baseTime + 20_000,
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );
    // SAFETY: This response contains the refresh metadata asserted below.
    const payload =
      (await response.json()) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as {
        metadata: JsonObject;
      };

    expect(response.status).toBe(200);
    expect(payload.metadata).toMatchObject({
      officialCheckedAt,
      refreshAvailableAt,
    });
    expect(response.headers.get("X-KF3-News-Official-Checked-At")).toBe(officialCheckedAt);
    expect(response.headers.get("X-KF3-News-Refresh-Available-At")).toBe(refreshAvailableAt);
    expect(JSON.parse(setup.cacheValues.get(NEWS_REFRESH_STATE_KEY) ?? "null")).toMatchObject({
      officialCheckedAt,
    });
  });

  it("refresh成功後に表示KVが期限切れしても公式確認日時を維持する", async () => {
    const officialCheckedAt = "2026-08-09T12:00:00.000Z";
    const setup = createBindings(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT)));
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      clock: () => Date.parse(officialCheckedAt),
    });
    const pending: Promise<unknown>[] = [];
    const refreshResponse = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
      pending,
    );
    expect(refreshResponse.status).toBe(200);
    await Promise.all(pending);

    setup.cacheValues.delete("kf3-news");
    setup.cacheMetadata.delete("kf3-news");
    setup.cacheValues.delete("kf3-news-archive-snapshot");
    setup.cacheMetadata.delete("kf3-news-archive-snapshot");
    const getResponse = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("X-KF3-News-Official-Checked-At")).toBe(officialCheckedAt);
    expect(setup.queueMessages).toHaveLength(0);
  });

  it("official-check-state保存はrefreshレスポンスを待たせない", async () => {
    let releasePut!: () => void;
    const checkStatePutBlock = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const document = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const setup = createBindings(JSON.stringify(document), undefined, { checkStatePutBlock });
    const pending: Promise<unknown>[] = [];
    const response = await callFetch(
      createWorkerHandler({ fetcher: async () => createResponse(document) }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
      pending,
    );

    expect(response.status).toBe(200);
    expect(pending).toHaveLength(1);

    releasePut();
    await Promise.all(pending);
  });

  it("refreshで既存お知らせの変更だけを検出した場合はQueueへ通知する", async () => {
    const archive = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const official = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    official.news[0] = { ...official.news[0], category: "updated" };
    const setup = createBindings(JSON.stringify(archive));
    const response = await callFetch(
      createWorkerHandler({ fetcher: async () => createResponse(official) }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(setup.queueMessages).toEqual([
      expect.objectContaining({ addedCount: 0, updatedCount: 1 }),
    ]);
  });

  it("refreshのmerge結果に変更がない場合はQueueへ通知しない", async () => {
    const document = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const setup = createBindings(JSON.stringify(document));
    const logs: JsonObject[] = [];
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(document),
        logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(200);
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    expect(
      (await response.json()) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as {
        news: unknown[];
      },
    ).toHaveProperty("news");
    expect(setup.queueMessages).toHaveLength(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_refresh_succeeded",
        archiveChanged: false,
        archiveUpdateNeeded: false,
        archiveUpdateQueueStatus: "not-needed",
      }),
    );
  });

  it("client data versionが一致する変更なしrefreshはnews全件を返さない", async () => {
    const document = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const setup = createBindings(JSON.stringify(document));
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(document),
      }),
      new Request("https://example.com/api/kf3-news/refresh", {
        method: "POST",
        headers: { "X-KF3-News-Data-Version": "current-etag" },
      }),
      setup.env,
    );
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    const payload =
      (await response.json()) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as JsonObject;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      changed: false,
      metadata: expect.objectContaining({
        version: 2,
        source: "merged",
        baseArchiveEtag: "current-etag",
        newsCount: MIN_OFFICIAL_ENTRY_COUNT,
      }),
    });
    expect(payload).not.toHaveProperty("news");
    expect(response.headers.get("X-KF3-News-Data-Version")).toBe("current-etag");
    expect(response.headers.get("Vary")).toBe("X-KF3-News-Data-Version");
  });

  it("current未作成ならmerge差分がなくても初期化Queue messageを送る", async () => {
    const legacy = createDocument(MIN_OFFICIAL_ENTRY_COUNT, true);
    const setup = createBindings(null, JSON.stringify(legacy));
    const logs: JsonObject[] = [];
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(legacy),
        logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(setup.queueMessages).toEqual([
      expect.objectContaining({
        reason: "refresh-current-missing",
        addedCount: 0,
        updatedCount: 0,
        requiresInitialization: true,
      }),
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_refresh_succeeded",
        requiresInitialization: true,
        archiveChanged: false,
        archiveUpdateNeeded: true,
      }),
    );
  });

  it("refreshの公式取得が304の場合はQueueへ通知しない", async () => {
    const document = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const setup = createBindings(JSON.stringify(document), undefined, {
      stateText: JSON.stringify({
        version: 1,
        officialEtag: '"official-etag"',
        currentEtag: "current-etag",
      }),
    });
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () =>
          new Response(null, { status: 304, headers: { etag: '"official-etag"' } }),
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(setup.queueMessages).toHaveLength(0);
  });

  it("refreshの304はETag一致したKV JSONを再利用してcurrent本文を読まない", async () => {
    const setup = createBindings(
      JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      undefined,
      {
        stateText: JSON.stringify({
          version: 1,
          officialEtag: '"official-etag"',
          currentEtag: "current-etag",
        }),
      },
    );
    const clientJson = JSON.stringify([
      {
        targetUrl: "/cached",
        title: "cached",
        newsDate: "2026年08月01日 12時00分00秒",
        updated: "",
      },
    ]);
    setup.cacheValues.set("kf3-news", clientJson);
    setup.cacheMetadata.set(
      "kf3-news",
      createNewsCacheMetadata("merged", "2026-08-09T12:00:00.000Z", "current-etag", 1),
    );
    const officialCheckedAt = Date.parse("2026-08-09T12:34:56.789Z");
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () =>
          new Response(null, { status: 304, headers: { etag: '"official-etag"' } }),
        clock: () => officialCheckedAt,
      }),
      new Request("https://example.com/api/kf3-news/refresh", {
        method: "POST",
        headers: { "X-KF3-News-Data-Version": "current-etag" },
      }),
      setup.env,
    );
    // SAFETY: The fixture provides the Worker fields consumed by this test.
    const payload =
      (await response.json()) /* SAFETY: The fixture provides the Worker fields consumed by this test. */ as JsonObject;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      changed: false,
      metadata: expect.objectContaining({ baseArchiveEtag: "current-etag" }),
    });
    expect(payload).not.toHaveProperty("news");
    expect(response.headers.get("X-KF3-News-Data-Version")).toBe("current-etag");
    expect(setup.dataGets).not.toContain(CURRENT_ARCHIVE_KEY);
    expect(setup.getCurrentHeadCalls()).toBe(1);
    expect(setup.cachePuts).toHaveLength(1);
    expect(setup.cachePuts[0].key).toBe(NEWS_REFRESH_STATE_KEY);
    expect(JSON.parse(setup.cachePuts[0].value)).toEqual({
      version: 1,
      baseArchiveEtag: "current-etag",
      officialCheckedAt: "2026-08-09T12:34:56.789Z",
      refreshAvailableAt: "2026-08-09T12:39:56.789Z",
    });
    expect(setup.cachePuts[0].metadata).toBeUndefined();
    expect(setup.cacheValues.get(NEWS_CACHE_KEY)).toBe(clientJson);
    expect(setup.queueMessages).toHaveLength(0);
  });

  it.each([
    {
      label: "v1 metadata",
      metadata: { version: 1, source: "merged", fetchedAt: "2026-08-09T12:00:00.000Z" },
    },
    { label: "metadataなし", metadata: null },
    {
      label: "ETag不一致",
      metadata: createNewsCacheMetadata("merged", "2026-08-09T12:00:00.000Z", "other-etag", 1),
    },
  ])("refreshの304は$labelならcurrent本文へfallbackする", async ({ metadata }) => {
    const setup = createBindings(
      JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      undefined,
      {
        stateText: JSON.stringify({
          version: 1,
          officialEtag: '"official-etag"',
          currentEtag: "current-etag",
        }),
      },
    );
    setup.cacheValues.set("kf3-news", "cached-json");
    if (metadata !== null) setup.cacheMetadata.set("kf3-news", metadata);
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () =>
          new Response(null, { status: 304, headers: { etag: '"official-etag"' } }),
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(setup.dataGets).toContain(CURRENT_ARCHIVE_KEY);
  });

  it("304からfull fallbackした場合は公式fetch回数を記録する", async () => {
    const document = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const setup = createBindings(JSON.stringify(document), undefined, {
      conditionalCurrentReadMismatch: true,
      stateText: JSON.stringify({
        version: 1,
        officialEtag: '"official-etag"',
        currentEtag: "current-etag",
      }),
    });
    const responses = [
      new Response(null, { status: 304, headers: { etag: '"official-etag"' } }),
      createResponse(document),
    ];
    const logs: JsonObject[] = [];
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => responses.shift()!,
        logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(responses).toHaveLength(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_refresh_succeeded",
        officialFetchCount: 2,
        officialFetchStatus: "modified",
        refreshDataSource: "full-merge",
      }),
    );
  });

  it("Queue送信失敗後もrefresh成功とKV更新を維持する", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      queueSendError: true,
    });
    const logs: JsonObject[] = [];
    const pending: Promise<unknown>[] = [];
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
        logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
      pending,
    );
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(setup.cachePuts).toHaveLength(2);
    expect(setup.queueMessages).toHaveLength(0);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "news_archive_update_enqueue_failed" }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_refresh_succeeded",
        archiveUpdateQueueStatus: "scheduled",
      }),
    );
  });

  it("Queue送信はレスポンスを待たせない", async () => {
    let releaseSend!: () => void;
    const queueSendBlock = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      queueSendBlock,
    });
    const pending: Promise<unknown>[] = [];
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
      pending,
    );

    expect(response.status).toBe(200);
    expect(pending).toHaveLength(2);
    expect(setup.queueMessages).toHaveLength(0);

    releaseSend();
    await Promise.all(pending);
    expect(setup.queueMessages).toHaveLength(1);
  });

  it("refreshのPOST以外は405とAllowを返す", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)));
    const handler = createWorkerHandler();
    for (const method of ["GET", "PUT", "PATCH"]) {
      const response = await callFetch(
        handler,
        new Request("https://example.com/api/kf3-news/refresh", { method }),
        setup.env,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("refresh完了CAS失敗後はKVを維持して202を返す", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      refreshCompleteResult: "lease-mismatch",
    });
    setup.cacheValues.set("kf3-news", "old-cache");
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );
    expect(response.status).toBe(202);
    expect(setup.cacheValues.get("kf3-news")).not.toBe("old-cache");
    expect(logs).not.toContainEqual(expect.objectContaining({ event: "news_refresh_succeeded" }));
    expect(logs).not.toContainEqual(expect.objectContaining({ event: "news_refresh_failed" }));
  });

  it("refresh完了の依存処理失敗時はKVを削除して503を返す", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      refreshCompleteError: new Error("completion failed"),
    });
    const logs: JsonObject[] = [];
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
        logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(503);
    expect(setup.cacheDeletes).toContain(NEWS_CACHE_KEY);
    expect(setup.cacheDeletes).toContain(NEWS_REFRESH_STATE_KEY);
    expect(setup.queueMessages).toHaveLength(0);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "news_refresh_control_completion_failed" }),
    );
    expect(logs).toContainEqual(expect.objectContaining({ event: "news_refresh_failed" }));
  });

  it("refresh leaseの延長競合時はKVを更新せず202にする", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      refreshRenewResult: "lease-mismatch",
    });
    const startedAt = Date.parse("2026-08-09T12:00:00.000Z");
    const clockValues = [startedAt, startedAt + 50_000];

    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
        clock: () => clockValues.shift() ?? startedAt + 50_000,
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(202);
    expect(setup.cachePuts).toHaveLength(0);
    expect(setup.queueMessages).toHaveLength(0);
  });

  it("refresh後にcurrentが競合するとstaleなKVを削除して503にする", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      conditionalCurrentMismatch: true,
    });
    let fetchCalls = 0;
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => {
          fetchCalls += 1;
          return createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT));
        },
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );
    expect(response.status).toBe(503);
    expect(fetchCalls).toBe(1);
    expect(setup.cachePuts).toHaveLength(1);
    expect(setup.cacheDeletes).toContain("kf3-news");
    expect(setup.queueMessages).toHaveLength(0);
  });

  it("KV保存中にcurrentが更新された場合はstaleなKVを削除して503にする", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      currentChangesOnCachePut: true,
    });
    setup.cacheValues.set("kf3-news", "old-cache");
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(503);
    expect(setup.cachePuts).toHaveLength(1);
    expect(setup.cacheDeletes).toContain("kf3-news");
    expect(setup.cacheValues.get("kf3-news")).toBeUndefined();
    expect(setup.queueMessages).toHaveLength(0);
  });

  it("refreshのlease失効をKV保存後に検出して202にする", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      refreshCompleteResult: "lease-mismatch",
    });
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );
    expect(response.status).toBe(202);
    expect(setup.cachePuts).toHaveLength(2);
    expect(setup.queueMessages).toHaveLength(0);
  });

  it("KV保存前にleaseを延長してfinalization中の再取得を防ぐ", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)));
    setup.cacheValues.set("kf3-news", "old-cache");
    const startedAt = Date.parse("2026-08-09T12:00:00.000Z");
    const clockValues = [startedAt, startedAt + 59_000, startedAt + 59_000, startedAt + 61_000];
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
        clock: () => clockValues.shift() ?? startedAt + 61_000,
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect(setup.cachePuts).toHaveLength(2);
    expect(setup.cacheDeletes).not.toContain("kf3-news");
    expect(setup.cacheValues.get("kf3-news")).not.toBe("old-cache");
    expect(setup.queueMessages).toHaveLength(1);
  });

  it("KV保存後にleaseが不一致でも次refreshのKVを削除しない", async () => {
    let setup!: TestBindings;
    setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      refreshCompleteResult: "lease-mismatch",
      refreshCompleteBeforeResult: () => setup.cacheValues.set("kf3-news", "newer-refresh-cache"),
    });
    setup.cacheValues.set("kf3-news", "old-cache");
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );

    expect(response.status).toBe(202);
    expect(setup.cachePuts).toHaveLength(2);
    expect(setup.cacheDeletes).not.toContain("kf3-news");
    expect(setup.cacheValues.get("kf3-news")).toBe("newer-refresh-cache");
    expect(setup.queueMessages).toHaveLength(0);
  });

  it("refresh失敗時は既存KVを維持して503にする", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)));
    setup.env.CF_VERSION_METADATA = {
      id: "version-refresh-failed",
      tag: "test-refresh-failed",
      timestamp: "2026-08-09T12:34:56.789Z",
    };
    setup.cacheValues.set("kf3-news", "old-cache");
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(null, false),
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );
    expect(response.status).toBe(503);
    expect(setup.cacheValues.get("kf3-news")).toBe("old-cache");
    expect(setup.cachePuts).toHaveLength(0);
    expect(setup.queueMessages).toHaveLength(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_refresh_failed",
        workerVersionId: "version-refresh-failed",
      }),
    );
  });

  it("legacy routeのGETとHEAD互換性を維持する", async () => {
    const legacyText = JSON.stringify({
      news: [{ targetUrl: "/legacy", title: "legacy", newsDate: "date", updated: "now" }],
    });
    const setup = createBindings(null, legacyText);
    const handler = createWorkerHandler();
    const getResponse = await callFetch(
      handler,
      new Request("https://example.com/entries_merged_20241107.json"),
      setup.env,
    );
    const headResponse = await callFetch(
      handler,
      new Request("https://example.com/entries_merged_20241107.json", { method: "HEAD" }),
      setup.env,
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe(legacyText);
    expect(getResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(getResponse.headers.get("etag")).toBe('"legacy-etag"');
    expect(headResponse.status).toBe(200);
    expect(await headResponse.text()).toBe("");
    expect(headResponse.headers.get("etag")).toBe('"legacy-etag"');
  });

  it("legacy object欠落時は5xxにする", async () => {
    const setup = createBindings(null, "unused", { legacyMissing: true });
    const handler = createWorkerHandler();
    const response = await callFetch(
      handler,
      new Request("https://example.com/entries_merged_20241107.json"),
      setup.env,
    );

    expect(response.status).toBe(500);
  });
});

describe("scheduled handler", () => {
  it("scheduledTimeと全bindingを渡し、完了までawaitする", async () => {
    const setup = createBindings(null);
    const scheduledTime = Date.parse("2026-08-01T03:00:00Z");
    const clock = () => scheduledTime + 1_000;
    let resolveUpdate: (() => void) | undefined;
    let received: NewsArchiveUpdateDependencies | undefined;
    const handler = createWorkerHandler({
      clock,
      updater: async (dependencies) => {
        received = dependencies;
        await new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        });
      },
    });
    const pending = callScheduled(handler, setup.env, scheduledTime);
    await Promise.resolve();
    expect(received?.nowMs).toBe(scheduledTime);
    expect(received?.clock).toBe(clock);
    expect(received?.dataBucket).toBe(setup.env.KF3_NOTIF_DATA);
    expect(received?.backupBucket).toBe(setup.env.KF3_NOTIF_BACKUP);
    expect(received?.cache).toBe(setup.env.KF3_NOTIF_CACHE);
    expect(received?.trigger).toBe("scheduled");
    expect(received?.invalidateDisplayCache).toBe(true);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveUpdate?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("scheduledの失敗をrejectする", async () => {
    const setup = createBindings(null);
    const handler = createWorkerHandler({
      updater: async () => Promise.reject(new Error("scheduled failed")),
    });
    await expect(callScheduled(handler, setup.env, Date.now())).rejects.toThrow("scheduled failed");
  });

  it("archive更新の前後にstartとsuccess heartbeatを送る", async () => {
    const setup = createBindings(null);
    setup.env.HEALTHCHECKS_PING_URL = "https://heartbeat.test/check";
    const events: string[] = [];
    const handler = createWorkerHandler({
      heartbeatFetcher: async (input) => {
        events.push(String(input).endsWith("/start") ? "start" : "success");
        return new Response(null, { status: 200 });
      },
      updater: async () => {
        events.push("update");
      },
    });
    await callScheduled(handler, setup.env, Date.now());
    expect(events).toEqual(["start", "update", "success"]);
  });

  it("archive更新失敗時にfail heartbeatを送って元のerrorを再throwする", async () => {
    const setup = createBindings(null);
    setup.env.HEALTHCHECKS_PING_URL = "https://heartbeat.test/check/";
    const requestedUrls: string[] = [];
    const originalError = new Error("scheduled failed");
    const handler = createWorkerHandler({
      heartbeatFetcher: async (input) => {
        requestedUrls.push(String(input));
        return new Response(null, { status: 200 });
      },
      updater: async () => Promise.reject(originalError),
    });
    await expect(callScheduled(handler, setup.env, Date.now())).rejects.toBe(originalError);
    expect(requestedUrls).toEqual([
      "https://heartbeat.test/check/start",
      "https://heartbeat.test/check/fail",
    ]);
  });

  it("heartbeat secret未設定ではheartbeatを送らない", async () => {
    const setup = createBindings(null);
    let heartbeatCalls = 0;
    const handler = createWorkerHandler({
      heartbeatFetcher: async () => {
        heartbeatCalls += 1;
        return new Response(null, { status: 200 });
      },
      updater: async () => undefined,
    });
    await callScheduled(handler, setup.env, Date.now());
    expect(heartbeatCalls).toBe(0);
  });

  it("heartbeat送信失敗でarchive更新を止めず、secretをlogへ出さない", async () => {
    const setup = createBindings(null);
    const secretUrl = "https://heartbeat.test/sensitive-secret";
    setup.env.HEALTHCHECKS_PING_URL = secretUrl;
    let updateCalls = 0;
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      heartbeatFetcher: async () => {
        throw new Error(`request failed: ${secretUrl}`);
      },
      updater: async () => {
        updateCalls += 1;
      },
      logger: { log: () => undefined, error: (event) => logs.push(event) },
    });
    await callScheduled(handler, setup.env, Date.now());
    expect(updateCalls).toBe(1);
    expect(logs).toEqual([
      {
        event: "news_archive_heartbeat_failed",
        stage: "heartbeat-start",
        error: "heartbeat request failed",
      },
      {
        event: "news_archive_heartbeat_failed",
        stage: "heartbeat-success",
        error: "heartbeat request failed",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(secretUrl);
  });

  it("heartbeatの非2xxでもarchive更新を継続する", async () => {
    const setup = createBindings(null);
    setup.env.HEALTHCHECKS_PING_URL = "https://heartbeat.test/check";
    let updateCalls = 0;
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      heartbeatFetcher: async () => new Response(null, { status: 503 }),
      updater: async () => {
        updateCalls += 1;
      },
      logger: { log: () => undefined, error: (event) => logs.push(event) },
    });

    await callScheduled(handler, setup.env, Date.now());

    expect(updateCalls).toBe(1);
    expect(logs).toEqual([
      {
        event: "news_archive_heartbeat_failed",
        stage: "heartbeat-start",
        error: "heartbeat request failed",
      },
      {
        event: "news_archive_heartbeat_failed",
        stage: "heartbeat-success",
        error: "heartbeat request failed",
      },
    ]);
  });

  it("fail heartbeat失敗時もarchive更新の元errorを維持する", async () => {
    const setup = createBindings(null);
    setup.env.HEALTHCHECKS_PING_URL = "https://heartbeat.test/check";
    const originalError = new Error("scheduled failed");
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      heartbeatFetcher: async (input) => {
        if (String(input).endsWith("/fail")) throw new Error("heartbeat failed");
        return new Response(null, { status: 200 });
      },
      updater: async () => Promise.reject(originalError),
      logger: { log: () => undefined, error: (event) => logs.push(event) },
    });

    await expect(callScheduled(handler, setup.env, Date.now())).rejects.toBe(originalError);
    expect(logs[0]).toMatchObject({
      event: "news_archive_heartbeat_failed",
      stage: "heartbeat-fail",
    });
  });

  it("heartbeatを10秒でtimeoutしてarchive更新を継続する", async () => {
    vi.useFakeTimers();
    try {
      const setup = createBindings(null);
      setup.env.HEALTHCHECKS_PING_URL = "https://heartbeat.test/check";
      let heartbeatCalls = 0;
      let updateCalls = 0;
      const logs: JsonObject[] = [];
      const handler = createWorkerHandler({
        heartbeatFetcher: async (_input, init) => {
          heartbeatCalls += 1;
          if (heartbeatCalls > 1) return new Response(null, { status: 200 });
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        },
        updater: async () => {
          updateCalls += 1;
        },
        logger: { log: () => undefined, error: (event) => logs.push(event) },
      });

      const pending = callScheduled(handler, setup.env, Date.now());
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;

      expect(updateCalls).toBe(1);
      expect(heartbeatCalls).toBe(2);
      expect(logs).toEqual([
        {
          event: "news_archive_heartbeat_failed",
          stage: "heartbeat-start",
          error: "heartbeat request failed",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("queue handler", () => {
  const message: NewsArchiveUpdateMessage = {
    version: NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION,
    reason: "refresh-detected-change",
    detectedAt: "2026-08-09T12:34:56.789Z",
    addedCount: 2,
    updatedCount: 1,
    requiresInitialization: false,
  };

  it("archive updaterをqueue triggerで実行してackする", async () => {
    const setup = createBindings(null);
    const nowMs = Date.parse("2026-08-09T12:35:00.000Z");
    let received: NewsArchiveUpdateDependencies | undefined;
    let heartbeatCalls = 0;
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      clock: () => nowMs,
      heartbeatFetcher: async () => {
        heartbeatCalls += 1;
        return new Response(null, { status: 200 });
      },
      updater: async (dependencies) => {
        received = dependencies;
      },
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });

    const result = await callQueue(handler, setup.env, message);

    expect(received).toMatchObject({
      dataBucket: setup.env.KF3_NOTIF_DATA,
      backupBucket: setup.env.KF3_NOTIF_BACKUP,
      cache: setup.env.KF3_NOTIF_CACHE,
      nowMs,
      trigger: "queue",
      invalidateDisplayCache: false,
    });
    expect(result.ack).toHaveBeenCalledOnce();
    expect(result.retry).not.toHaveBeenCalled();
    expect(heartbeatCalls).toBe(0);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_archive_queue_succeeded",
        reason: "refresh-detected-change",
      }),
    );
  });

  it("current初期化messageは差分件数0でもarchive updaterを実行してackする", async () => {
    const setup = createBindings(null);
    let updateCalls = 0;
    const handler = createWorkerHandler({
      updater: async () => {
        updateCalls += 1;
      },
    });

    const result = await callQueue(handler, setup.env, {
      ...message,
      reason: "refresh-current-missing",
      addedCount: 0,
      updatedCount: 0,
      requiresInitialization: true,
    });

    expect(updateCalls).toBe(1);
    expect(result.ack).toHaveBeenCalledOnce();
    expect(result.retry).not.toHaveBeenCalled();
  });

  it("archive updater失敗時はackせず60秒後にretryする", async () => {
    const setup = createBindings(null);
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      updater: async () => Promise.reject(new Error("queue update failed")),
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });

    const result = await callQueue(handler, setup.env, message);

    expect(result.ack).not.toHaveBeenCalled();
    expect(result.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(logs).toContainEqual(expect.objectContaining({ event: "news_archive_queue_failed" }));
  });

  it("不正な時刻または差分件数のmessageはarchive updaterを実行せずackする", async () => {
    const setup = createBindings(null);
    let updateCalls = 0;
    const handler = createWorkerHandler({
      updater: async () => {
        updateCalls += 1;
      },
      logger: { log: () => undefined, error: () => undefined },
    });

    const invalidTimestamp = await callQueue(handler, setup.env, {
      ...message,
      detectedAt: "not-a-date",
    });
    const noChanges = await callQueue(handler, setup.env, {
      ...message,
      addedCount: 0,
      updatedCount: 0,
    });
    const mismatchedInitialization = await callQueue(handler, setup.env, {
      ...message,
      requiresInitialization: true,
    });

    expect(updateCalls).toBe(0);
    expect(invalidTimestamp.ack).toHaveBeenCalledOnce();
    expect(noChanges.ack).toHaveBeenCalledOnce();
    expect(mismatchedInitialization.ack).toHaveBeenCalledOnce();
  });

  it("未知versionのmessageはarchive updaterを実行せずackする", async () => {
    const setup = createBindings(null);
    let updateCalls = 0;
    const logs: JsonObject[] = [];
    const handler = createWorkerHandler({
      updater: async () => {
        updateCalls += 1;
      },
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });

    const result = await callQueue(handler, setup.env, { ...message, version: 999 });

    expect(updateCalls).toBe(0);
    expect(result.ack).toHaveBeenCalledOnce();
    expect(result.retry).not.toHaveBeenCalled();
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "news_archive_queue_invalid_message" }),
    );
  });
});
