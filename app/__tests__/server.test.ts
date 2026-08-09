import { describe, expect, it } from "vitest";
import type {
  ExecutionContext,
  Fetcher,
  KVNamespace,
  R2Bucket,
  R2ObjectBody,
} from "@cloudflare/workers-types/experimental";
import {
  CURRENT_ARCHIVE_KEY,
  LEGACY_ARCHIVE_KEY,
  type NewsArchiveUpdateDependencies,
} from "../news-archive";
import { MIN_OFFICIAL_ENTRY_COUNT } from "../news-data";
import { createWorkerHandler } from "../server";

const createNews = (id: number) => ({
  id,
  targetUrl: `/info/${id}`,
  title: `ニュース${id}`,
  newsDate: "2026年08月01日 12時00分00秒",
  updated: "2026年08月01日 12時00分00秒",
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
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  }) as unknown as R2ObjectBody;

const createResponse = (document: unknown, ok = true) =>
  new Response(ok ? JSON.stringify(document) : "failed", { status: ok ? 200 : 503 });

type TestBindings = {
  env: WorkerBindings;
  dataGets: string[];
  cacheValues: Map<string, string>;
  cachePuts: Array<{ key: string; value: string; expirationTtl?: number }>;
  cacheDeletes: string[];
};

type BindingOptions = {
  cacheGetError?: boolean;
  cachePutError?: boolean;
  legacyMissing?: boolean;
};

const createBindings = (
  currentText: string | null,
  legacyText = JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT, true)),
  options: BindingOptions = {},
): TestBindings => {
  const dataGets: string[] = [];
  const cacheValues = new Map<string, string>();
  const cachePuts: Array<{ key: string; value: string; expirationTtl?: number }> = [];
  const cacheDeletes: string[] = [];
  const dataBucket = {
    get: async (key: string) => {
      dataGets.push(key);
      if (key === CURRENT_ARCHIVE_KEY && currentText !== null)
        return createR2Object(currentText, "current-etag");
      if (key === LEGACY_ARCHIVE_KEY && !options.legacyMissing)
        return createR2Object(legacyText, "legacy-etag");
      return null;
    },
  } as unknown as R2Bucket;
  const cache = {
    get: async (key: string) => {
      if (options.cacheGetError) throw new Error("cache get failed");
      return cacheValues.get(key) ?? null;
    },
    put: async (key: string, value: string, putOptions: { expirationTtl?: number }) => {
      if (options.cachePutError) throw new Error("cache put failed");
      cacheValues.set(key, value);
      cachePuts.push({ key, value, expirationTtl: putOptions.expirationTtl });
    },
    delete: async (key: string) => {
      cacheDeletes.push(key);
      cacheValues.delete(key);
    },
  } as unknown as KVNamespace;
  const backup = {
    get: async () => null,
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
    expect(await response.json()).toEqual(cached);
    expect(setup.dataGets).toEqual([]);
    expect(fetchCalls).toBe(0);
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
    expect(fetchCalls).toBe(0);
    expect(setup.dataGets).toEqual([]);
    expect(setup.cacheDeletes).toEqual([]);
    expect(setup.cachePuts).toEqual([]);
  });

  it("cache missではニュースの入力順を維持する", async () => {
    const setup = createBindings(JSON.stringify(createDocument(2)));
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
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
    expect(body.at(-1)?.targetUrl).toBe(`/info/${MIN_OFFICIAL_ENTRY_COUNT}`);
    expect(setup.cachePuts[0].expirationTtl).toBe(300);
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

  it("cache保存失敗時は5xxにしてarchive件数をlogへ残す", async () => {
    const setup = createBindings(JSON.stringify(createDocument(1)), undefined, {
      cachePutError: true,
    });
    const logs: Record<string, unknown>[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      logger: { log: () => undefined, error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );

    expect(response.status).toBe(500);
    expect(setup.cachePuts).toEqual([]);
    expect(logs[0]).toMatchObject({
      event: "news_api_error",
      stage: "unknown",
      archiveCount: MIN_OFFICIAL_ENTRY_COUNT,
    });
  });

  it("公式取得失敗時はarchiveをTTL 60で返す", async () => {
    const archive = createDocument(MIN_OFFICIAL_ENTRY_COUNT, true);
    const setup = createBindings(JSON.stringify(archive));
    const logs: Record<string, unknown>[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(null, false),
      logger: { log: () => undefined, error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown[]).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(setup.cachePuts[0].expirationTtl).toBe(60);
    expect(logs[0]).toMatchObject({ event: "news_api_fallback", stage: "official-fetch" });
  });

  it("公式データの統合検証失敗時もarchiveをTTL 60で返す", async () => {
    const archive = createDocument(MIN_OFFICIAL_ENTRY_COUNT, true);
    const official = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    official.news[0].targetUrl = "//other.example/news";
    const setup = createBindings(JSON.stringify(archive));
    const logs: Record<string, unknown>[] = [];
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(official),
      logger: { log: () => undefined, error: (event) => logs.push(event) },
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown[]).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(setup.cachePuts[0].expirationTtl).toBe(60);
    expect(logs[0]).toMatchObject({ event: "news_api_fallback", stage: "official-validation" });
  });

  it("archive失敗時は公式だけを返さず5xxにする", async () => {
    const setup = createBindings(null, "invalid");
    const handler = createWorkerHandler({
      fetcher: async () => createResponse(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
    });
    const response = await callFetch(
      handler,
      new Request("https://example.com/api/kf3-news"),
      setup.env,
    );
    expect(response.status).toBe(500);
    expect(setup.cachePuts).toHaveLength(0);
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
});
