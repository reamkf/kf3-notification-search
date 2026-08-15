import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionContext,
  Fetcher,
  KVNamespace,
  R2Bucket,
  R2Object,
  R2ObjectBody,
} from "@cloudflare/workers-types/experimental";
import {
  CURRENT_ARCHIVE_KEY,
  LEGACY_ARCHIVE_KEY,
  OFFICIAL_FETCH_STATE_KEY,
  type NewsArchiveUpdateDependencies,
} from "../news-archive";
import { MIN_OFFICIAL_ENTRY_COUNT } from "../news-data";
import { createWorkerHandler } from "../server";
import { createNewsCacheMetadata } from "../news-response-metadata";

const createNews = (id: number, category?: string) => ({
  id,
  targetUrl: `/info/${id}`,
  title: `ニュース${id}`,
  newsDate: "2026年08月01日 12時00分00秒",
  updated: "2026年08月01日 12時00分00秒",
  ...(category !== undefined ? { category } : {}),
});

const createDocument = (count: number, sorted = false) => {
  const news = Array.from({ length: count }, (_, index) => createNews(index + 1));
  if (sorted) news.reverse();
  return { news };
};

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
  }) as unknown as R2ObjectBody;

const createResponse = (document: unknown, ok = true) =>
  new Response(ok ? JSON.stringify(document) : "failed", { status: ok ? 200 : 503 });

type TestBindings = {
  env: WorkerBindings;
  dataGets: string[];
  cacheValues: Map<string, string>;
  cacheMetadata: Map<string, unknown>;
  cachePuts: Array<{
    key: string;
    value: string;
    expirationTtl?: number;
    metadata?: unknown;
  }>;
  cacheDeletes: string[];
};

type BindingOptions = {
  cacheGetError?: boolean;
  cachePutError?: boolean;
  legacyMissing?: boolean;
  stateText?: string;
  stateEtag?: string;
  conditionalCurrentMismatch?: boolean;
};

const createBindings = (
  currentText: string | null,
  legacyText = JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT, true)),
  options: BindingOptions = {},
): TestBindings => {
  const dataGets: string[] = [];
  let currentHeadCalls = 0;
  const cacheValues = new Map<string, string>();
  const cacheMetadata = new Map<string, unknown>();
  const cachePuts: Array<{
    key: string;
    value: string;
    expirationTtl?: number;
    metadata?: unknown;
  }> = [];
  const cacheDeletes: string[] = [];
  const dataBucket = {
    get: async (key: string, getOptions?: { onlyIf?: { etagMatches?: string } }) => {
      dataGets.push(key);
      if (
        key === CURRENT_ARCHIVE_KEY &&
        getOptions?.onlyIf?.etagMatches !== undefined &&
        options.conditionalCurrentMismatch
      ) {
        return { etag: "new-current-etag" } as R2Object;
      }
      if (key === CURRENT_ARCHIVE_KEY && currentText !== null)
        return createR2Object(currentText, "current-etag");
      if (key === LEGACY_ARCHIVE_KEY && !options.legacyMissing)
        return createR2Object(legacyText, "legacy-etag");
      if (key === OFFICIAL_FETCH_STATE_KEY && options.stateText !== undefined)
        return createR2Object(options.stateText, options.stateEtag ?? "state-etag");
      return null;
    },
    head: async (key: string) => {
      if (key === CURRENT_ARCHIVE_KEY && currentText !== null) {
        currentHeadCalls += 1;
        return {
          etag: options.conditionalCurrentMismatch ? "new-current-etag" : "current-etag",
        } as R2Object;
      }
      return null;
    },
  } as unknown as R2Bucket;
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
      cacheValues.set(key, value);
      if (putOptions.metadata === undefined) cacheMetadata.delete(key);
      else cacheMetadata.set(key, putOptions.metadata);
      cachePuts.push({
        key,
        value,
        expirationTtl: putOptions.expirationTtl,
        metadata: putOptions.metadata,
      });
    },
    delete: async (key: string) => {
      cacheDeletes.push(key);
      cacheValues.delete(key);
      cacheMetadata.delete(key);
    },
  } as unknown as KVNamespace;
  const backup = {
    get: async () => null,
    head: async () => null,
    put: async () => null,
  } as unknown as R2Bucket;
  return {
    env: {
      ASSETS: {} as Fetcher,
      KF3_NOTIF_CACHE: cache,
      KF3_NOTIF_DATA: dataBucket,
      KF3_NOTIF_BACKUP: backup,
    },
    dataGets,
    cacheValues,
    cacheMetadata,
    cachePuts,
    cacheDeletes,
  };
};

const createContext = () =>
  ({
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  }) as unknown as ExecutionContext;

type WorkerFetch = NonNullable<ReturnType<typeof createWorkerHandler>["fetch"]>;
type WorkerScheduled = NonNullable<ReturnType<typeof createWorkerHandler>["scheduled"]>;

const callFetch = async (
  handler: ReturnType<typeof createWorkerHandler>,
  request: Request,
  env: WorkerBindings,
) =>
  (await handler.fetch?.(
    request as unknown as Parameters<WorkerFetch>[0],
    env as unknown as Parameters<WorkerFetch>[1],
    createContext() as unknown as Parameters<WorkerFetch>[2],
  )) as unknown as Response;

const callScheduled = async (
  handler: ReturnType<typeof createWorkerHandler>,
  env: WorkerBindings,
  scheduledTime: number,
) =>
  handler.scheduled?.(
    { scheduledTime } as unknown as Parameters<WorkerScheduled>[0],
    env as unknown as Parameters<WorkerScheduled>[1],
    createContext() as unknown as Parameters<WorkerScheduled>[2],
  );

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
    setup.cacheMetadata.set(
      "kf3-news",
      createNewsCacheMetadata("archive-fallback", "2026-08-09T12:34:56.789Z"),
    );
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
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cached);
    expect(response.headers.get("X-KF3-News-Source")).toBe("archive-fallback");
    expect(response.headers.get("X-KF3-News-Fetched-At")).toBe("2026-08-09T12:34:56.789Z");
    expect(setup.dataGets).toEqual([]);
    expect(fetchCalls).toBe(0);
    expect(clockCalls).toBe(0);
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
    expect(response.headers.get("X-KF3-News-Fetched-At")).toBeNull();
    expect(fetchCalls).toBe(0);
    expect(setup.dataGets).toEqual([]);
    expect(setup.cacheDeletes).toEqual([]);
    expect(setup.cachePuts).toEqual([]);
  });

  it("cache missでは公式取得せずarchive snapshotを返し、KVへ保存しない", async () => {
    const setup = createBindings(JSON.stringify(createDocument(2)));
    const fetchedAt = Date.parse("2026-08-09T12:34:56.789Z");
    const handler = createWorkerHandler({
      fetcher: async () => {
        throw new Error("unexpected fetch");
      },
      clock: () => fetchedAt,
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    const body = (await response.json()) as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(body[0].targetUrl).toBe("/info/1");
    expect(body[1].targetUrl).toBe("/info/2");
    expect(body).toHaveLength(2);
    expect(response.headers.get("X-KF3-News-Source")).toBe("archive-snapshot");
    expect(response.headers.get("X-KF3-News-Fetched-At")).toBe("2026-08-09T12:34:56.789Z");
    expect(setup.cachePuts).toHaveLength(0);
  });

  it("cache missではrefresh制御metadataへアクセスしない", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)));
    const response = await callFetch(
      createWorkerHandler(),
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(response.status).toBe(200);
    expect(setup.dataGets).not.toContain("control/news-refresh.json");
    expect(setup.cachePuts).toHaveLength(0);
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
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown[]).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(requestHeaders).toHaveLength(0);
    expect(setup.cachePuts).toHaveLength(0);
  });

  it("公式取得とcurrent読み込みが両方失敗した場合はarchive-readを優先する", async () => {
    const setup = createBindings("invalid", undefined, {
      stateText: JSON.stringify({
        version: 1,
        officialEtag: '"official-etag"',
        currentEtag: "current-etag",
      }),
    });
    const logs: Record<string, unknown>[] = [];
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
    const logs: Record<string, unknown>[] = [];
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
    const originalData = setup.env.KF3_NOTIF_DATA;
    let controlText: string | null = null;
    let controlEtag = "control-etag-0";
    setup.env.KF3_NOTIF_DATA = {
      get: async (key: string, options?: unknown) => {
        if (key === "control/news-refresh.json") {
          return controlText === null ? null : createR2Object(controlText, controlEtag);
        }
        return originalData.get(key, options as never);
      },
      head: originalData.head.bind(originalData),
      put: async (key: string, value: string) => {
        if (key === "control/news-refresh.json") {
          controlText = value;
          controlEtag = `control-etag-${controlText.length}`;
          return { etag: controlEtag } as R2Object;
        }
        return null;
      },
    } as unknown as R2Bucket;
    const logs: Record<string, unknown>[] = [];
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
    const payload = (await response.json()) as {
      news: Array<Record<string, unknown>>;
      metadata: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.news).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(payload.news[0].category).toBe("refresh");
    expect(payload.metadata).toEqual(createNewsCacheMetadata("merged", "2026-08-09T12:34:56.789Z"));
    expect(response.headers.get("X-KF3-News-Source")).toBe("merged");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(setup.cachePuts[0].expirationTtl).toBe(300);
    expect(setup.cachePuts[0].metadata).toEqual(payload.metadata);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "news_refresh_succeeded",
        archiveCount: MIN_OFFICIAL_ENTRY_COUNT,
      }),
    );
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

  it("refresh完了CAS失敗後もKV更新済みの成功を返し失敗ログを出さない", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)));
    setup.cacheValues.set("kf3-news", "old-cache");
    const originalData = setup.env.KF3_NOTIF_DATA;
    let controlText: string | null = null;
    let controlEtag = "control-0";
    let puts = 0;
    setup.env.KF3_NOTIF_DATA = {
      get: async (key: string, options?: unknown) => {
        if (key === "control/news-refresh.json") {
          return controlText === null ? null : createR2Object(controlText, controlEtag);
        }
        return originalData.get(key, options as never);
      },
      head: originalData.head.bind(originalData),
      put: async (key: string, value: string) => {
        if (key !== "control/news-refresh.json") return null;
        puts += 1;
        if (puts > 1) return null;
        controlText = value;
        controlEtag = "control-1";
        return { etag: controlEtag } as R2Object;
      },
    } as unknown as R2Bucket;
    const logs: Record<string, unknown>[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      logger: { log: (event) => logs.push(event), error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );
    expect(response.status).toBe(200);
    expect(setup.cacheValues.get("kf3-news")).not.toBe("old-cache");
    expect(logs).toContainEqual(expect.objectContaining({ event: "news_refresh_succeeded" }));
    expect(logs).not.toContainEqual(expect.objectContaining({ event: "news_refresh_failed" }));
  });

  it("refresh中にcurrentが競合するとKVを更新せず503にする", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)));
    let headCalls = 0;
    const originalData = setup.env.KF3_NOTIF_DATA;
    setup.env.KF3_NOTIF_DATA = {
      get: originalData.get.bind(originalData),
      head: async (key: string) => {
        if (key === CURRENT_ARCHIVE_KEY) {
          headCalls += 1;
          return { etag: headCalls > 1 ? "changed-current" : "current-etag" } as R2Object;
        }
        return null;
      },
      put: originalData.put?.bind(originalData),
    } as unknown as R2Bucket;
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );
    expect(response.status).toBe(503);
    expect(setup.cachePuts).toHaveLength(0);
  });

  it("refreshのlease失効時はKVを更新せず202にする", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)));
    const originalData = setup.env.KF3_NOTIF_DATA;
    let controlText: string | null = null;
    setup.env.KF3_NOTIF_DATA = {
      get: async (key: string, options?: unknown) => {
        if (key === "control/news-refresh.json") {
          if (controlText === null) return null;
          return createR2Object(controlText, "control-etag");
        }
        return originalData.get(key, options as never);
      },
      head: originalData.head.bind(originalData),
      put: async (key: string, _value: string) => {
        if (key === "control/news-refresh.json") {
          controlText = JSON.stringify({
            version: 1,
            status: "running",
            token: "other-token",
            leaseUntil: "2000-01-01T00:00:00.000Z",
            cooldownUntil: null,
            lastOutcome: null,
          });
          return { etag: "control-etag" } as R2Object;
        }
        return null;
      },
    } as unknown as R2Bucket;
    const response = await callFetch(
      createWorkerHandler({
        fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      }),
      new Request("https://example.com/api/kf3-news/refresh", { method: "POST" }),
      setup.env,
    );
    expect(response.status).toBe(202);
    expect(setup.cachePuts).toHaveLength(0);
  });

  it("refresh失敗時は既存KVを維持して503にする", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)));
    setup.cacheValues.set("kf3-news", "old-cache");
    const logs: Record<string, unknown>[] = [];
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
    expect(logs).toContainEqual(expect.objectContaining({ event: "news_refresh_failed" }));
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
    let resolveUpdate: (() => void) | undefined;
    let received: NewsArchiveUpdateDependencies | undefined;
    const handler = createWorkerHandler({
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
    expect(received?.dataBucket).toBe(setup.env.KF3_NOTIF_DATA);
    expect(received?.backupBucket).toBe(setup.env.KF3_NOTIF_BACKUP);
    expect(received?.cache).toBe(setup.env.KF3_NOTIF_CACHE);
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
    const logs: Record<string, unknown>[] = [];
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
    const logs: Record<string, unknown>[] = [];
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
    const logs: Record<string, unknown>[] = [];
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
      const logs: Record<string, unknown>[] = [];
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
