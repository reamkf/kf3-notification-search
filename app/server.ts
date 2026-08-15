import type { ExportedHandler } from "@cloudflare/workers-types";
import type { Context } from "hono";
import { createHono } from "honox/factory";
import { createApp } from "honox/server";
import {
  CURRENT_ARCHIVE_KEY,
  LEGACY_ARCHIVE_KEY,
  NewsArchiveError,
  fetchOfficialNews,
  readArchiveDocument,
  readCurrentArchiveDocumentIfEtag,
  readOfficialFetchEligibility,
  serializeArchiveErrorForLog,
  updateNewsArchive,
  type ArchiveLogger,
  type NewsArchiveUpdateDependencies,
  type NewsFetcher,
} from "./news-archive";
import {
  NewsDataError,
  mergeValidatedNewsDocument,
  projectValidatedClientNews,
  type ValidatedNewsMergeResult,
} from "./news-data";
import {
  acquireNewsRefreshLease,
  completeNewsRefreshLease,
  hasActiveNewsRefreshLease,
  type NewsRefreshAcquireResult,
} from "./news-refresh-control";
import {
  createNewsCacheMetadata,
  createNewsResponseHeaders,
  type NewsCacheMetadata,
} from "./news-response-metadata";

const oldNewsPath = `/${LEGACY_ARCHIVE_KEY}`;
const cacheKey = "kf3-news";
const normalCacheTtl = 60 * 5;
const heartbeatTimeoutMs = 10_000;

export type ServerDependencies = {
  fetcher?: NewsFetcher;
  heartbeatFetcher?: typeof fetch;
  updater?: (dependencies: NewsArchiveUpdateDependencies) => Promise<unknown>;
  logger?: ArchiveLogger;
  clock?: () => number;
};

const defaultLogger: ArchiveLogger = {
  log: (event) => console.log(event),
  error: (event) => console.error(event),
};

const getOldNewsObject = async (bucket: WorkerBindings["KF3_NOTIF_DATA"]) => {
  const object = await bucket.get(LEGACY_ARCHIVE_KEY);
  if (!object) {
    throw new Error("旧ニュースデータがR2に見つかりません");
  }
  return object;
};

const getErrorStage = (error: unknown) => {
  if (error instanceof NewsArchiveError || error instanceof NewsDataError) return error.stage;
  return "unknown";
};

const createApiErrorLog = (error: unknown, archiveCount: number | null = null) => ({
  event: "news_api_error",
  stage: getErrorStage(error),
  error: "ニュースAPI処理に失敗しました",
  originalError: serializeArchiveErrorForLog(error),
  archiveCount,
});

const createRefreshErrorLog = (error: unknown, archiveCount: number | null = null) => ({
  event: "news_refresh_failed",
  stage: getErrorStage(error),
  error: "ニュース更新に失敗しました",
  originalError: serializeArchiveErrorForLog(error),
  archiveCount,
});

const refreshPath = "/api/kf3-news/refresh";

const createJsonResponse = (json: string, metadata?: NewsCacheMetadata) => {
  const headers = createNewsResponseHeaders(metadata);
  headers.set("cache-control", "no-store");
  return new Response(json, { headers });
};

const createRefreshResponse = (
  news: ReturnType<typeof projectValidatedClientNews>,
  metadata: NewsCacheMetadata,
) => createJsonResponse(JSON.stringify({ news, metadata }), metadata);

type HeartbeatStage = "heartbeat-start" | "heartbeat-success" | "heartbeat-fail";

const sendHeartbeat = async (
  baseUrl: string | undefined,
  stage: HeartbeatStage,
  fetcher: typeof fetch,
  logger: ArchiveLogger,
) => {
  if (!baseUrl) return;
  const suffix = stage === "heartbeat-start" ? "/start" : stage === "heartbeat-fail" ? "/fail" : "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), heartbeatTimeoutMs);
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, "")}${suffix}`, {
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("heartbeat request failed");
  } catch {
    logger.error({
      event: "news_archive_heartbeat_failed",
      stage,
      error: "heartbeat request failed",
    });
  } finally {
    clearTimeout(timeout);
  }
};

const readArchiveSnapshot = async (env: WorkerBindings) => {
  const archive = await readArchiveDocument(env.KF3_NOTIF_DATA);
  return {
    archive,
    clientNews: projectValidatedClientNews(archive.document),
  };
};

type RefreshNewsResult = {
  news: ReturnType<typeof projectValidatedClientNews>;
  currentEtag: string | null;
};

const getRefreshNewsUnconditionally = async (
  env: WorkerBindings,
  dependencies: ServerDependencies,
): Promise<RefreshNewsResult> => {
  const [archiveResult, officialResult] = await Promise.allSettled([
    readArchiveDocument(env.KF3_NOTIF_DATA),
    fetchOfficialNews(dependencies.fetcher ?? fetch),
  ]);
  if (archiveResult.status === "rejected") throw archiveResult.reason;
  if (officialResult.status === "rejected") throw officialResult.reason;
  if (officialResult.value.status !== "modified") {
    throw new NewsArchiveError("official-fetch", "公式ニュースの応答形式が不正です");
  }
  const merged = mergeValidatedNewsDocument(
    archiveResult.value.document,
    officialResult.value.document,
    {
      validateOfficialEntries: true,
    },
  );
  return {
    news: projectValidatedClientNews(merged.document),
    currentEtag: archiveResult.value.etag,
  };
};

const getRefreshNews = async (
  env: WorkerBindings,
  dependencies: ServerDependencies,
): Promise<RefreshNewsResult> => {
  const eligibility = await readOfficialFetchEligibility(env.KF3_NOTIF_DATA);
  if (!eligibility.ifNoneMatch) return getRefreshNewsUnconditionally(env, dependencies);

  const official = await fetchOfficialNews(dependencies.fetcher ?? fetch, {
    ifNoneMatch: eligibility.ifNoneMatch,
  });
  if (official.status === "not-modified") {
    const current = await readCurrentArchiveDocumentIfEtag(
      env.KF3_NOTIF_DATA,
      eligibility.state?.currentEtag ?? "",
    );
    if (current) {
      return {
        news: projectValidatedClientNews(current.document),
        currentEtag: current.etag,
      };
    }
    return getRefreshNewsUnconditionally(env, dependencies);
  }

  const archive = await readArchiveDocument(env.KF3_NOTIF_DATA);
  let merged: ValidatedNewsMergeResult;
  merged = mergeValidatedNewsDocument(archive.document, official.document, {
    validateOfficialEntries: true,
  });
  return {
    news: projectValidatedClientNews(merged.document),
    currentEtag: archive.etag,
  };
};

const getRetryHeaders = (retryAfterSeconds: number) =>
  new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": String(retryAfterSeconds),
  });

const createRefreshBusyResponse = (
  result: Exclude<NewsRefreshAcquireResult, { status: "acquired" }>,
) => {
  const headers = getRetryHeaders(result.retryAfterSeconds);
  const body =
    result.status === "running"
      ? { error: "ニュース更新が実行中です", leaseUntil: result.leaseUntil }
      : { error: "ニュース更新はクールダウン中です", nextAvailableAt: result.nextAvailableAt };
  if (result.status === "cooldown") {
    headers.set("x-kf3-news-refresh-next-available-at", result.nextAvailableAt);
  }
  return new Response(JSON.stringify(body), {
    status: result.status === "running" ? 202 : 429,
    headers,
  });
};

const createNewsApp = (dependencies: ServerDependencies) => {
  const baseApp = createHono();
  const logger = dependencies.logger ?? defaultLogger;

  baseApp.on(["GET", "HEAD"], oldNewsPath, async (context) => {
    const object = await getOldNewsObject(context.env.KF3_NOTIF_DATA);
    const headers = new Headers();
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "public, max-age=31536000, immutable");
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    return new Response(context.req.method === "HEAD" ? null : await object.arrayBuffer(), {
      headers,
    });
  });

  baseApp.get("/api/kf3-news", async (context) => {
    let archiveCount: number | null = null;
    try {
      const cachedNews =
        await context.env.KF3_NOTIF_CACHE.getWithMetadata<NewsCacheMetadata>(cacheKey);
      if (cachedNews.value !== null)
        return createJsonResponse(cachedNews.value, cachedNews.metadata ?? undefined);

      const snapshot = await readArchiveSnapshot(context.env);
      archiveCount = snapshot.clientNews.length;
      const fetchedAt = new Date(dependencies.clock?.() ?? Date.now()).toISOString();
      const metadata = createNewsCacheMetadata("archive-snapshot", fetchedAt);
      return createJsonResponse(JSON.stringify(snapshot.clientNews), metadata);
    } catch (error) {
      logger.error(createApiErrorLog(error, archiveCount));
      return context.json({ error: "ニュースデータの取得に失敗しました" }, 500);
    }
  });

  const refreshNews = async (
    context: Context<
      {
        Bindings: WorkerBindings;
        Variables: {};
      },
      typeof refreshPath
    >,
  ) => {
    let archiveCount: number | null = null;
    let token: string | null = null;
    try {
      const acquired = await acquireNewsRefreshLease(
        context.env.KF3_NOTIF_DATA,
        dependencies.clock?.() ?? Date.now(),
      );
      if (acquired.status !== "acquired") {
        logger.error({
          event: "news_refresh_failed",
          stage: "refresh-control",
          error:
            acquired.status === "running"
              ? "ニュース更新が実行中です"
              : "ニュース更新はクールダウン中です",
          archiveCount,
          reason: acquired.status,
          retryAfterSeconds: acquired.retryAfterSeconds,
        });
        return createRefreshBusyResponse(acquired);
      }
      token = acquired.token;

      let result = await getRefreshNews(context.env, dependencies);
      let current = await context.env.KF3_NOTIF_DATA.head(CURRENT_ARCHIVE_KEY);
      if ((result.currentEtag ?? null) !== (current?.etag ?? null)) {
        result = await getRefreshNews(context.env, dependencies);
        current = await context.env.KF3_NOTIF_DATA.head(CURRENT_ARCHIVE_KEY);
        if ((result.currentEtag ?? null) !== (current?.etag ?? null)) {
          throw new NewsArchiveError("etag-conflict", "refresh中にcurrentが競合しました");
        }
      }
      archiveCount = result.news.length;
      if (
        !(await hasActiveNewsRefreshLease(
          context.env.KF3_NOTIF_DATA,
          token,
          dependencies.clock?.() ?? Date.now(),
        ))
      ) {
        return new Response(JSON.stringify({ error: "ニュース更新のleaseが失効しました" }), {
          status: 202,
          headers: getRetryHeaders(1),
        });
      }
      const fetchedAt = new Date(dependencies.clock?.() ?? Date.now()).toISOString();
      const metadata = createNewsCacheMetadata("merged", fetchedAt);
      const responseJson = JSON.stringify(result.news);
      await context.env.KF3_NOTIF_CACHE.put(cacheKey, responseJson, {
        expirationTtl: normalCacheTtl,
        metadata,
      });
      let leaseCompletion: string;
      try {
        leaseCompletion = await completeNewsRefreshLease(
          context.env.KF3_NOTIF_DATA,
          token,
          "success",
          dependencies.clock?.() ?? Date.now(),
        );
      } catch (error) {
        leaseCompletion = "error";
        logger.error({
          event: "news_refresh_control_completion_failed",
          originalError: serializeArchiveErrorForLog(error),
        });
      }
      logger.log({
        event: "news_refresh_succeeded",
        archiveCount,
        mergedCount: result.news.length,
        leaseCompletion,
      });
      return createRefreshResponse(result.news, metadata);
    } catch (error) {
      logger.error(createRefreshErrorLog(error, archiveCount));
      if (token !== null) {
        try {
          await completeNewsRefreshLease(
            context.env.KF3_NOTIF_DATA,
            token,
            "failure",
            dependencies.clock?.() ?? Date.now(),
          );
        } catch (completionError) {
          logger.error(createRefreshErrorLog(completionError, archiveCount));
        }
      }
      return context.json({ error: "ニュース更新に失敗しました" }, 503);
    }
  };

  baseApp.all(refreshPath, async (context) => {
    if (context.req.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    return refreshNews(context);
  });

  return baseApp;
};

export const createWorkerHandler = (
  dependencies: ServerDependencies = {},
  options: { useHonoxApp?: boolean } = {},
): ExportedHandler<WorkerBindings> => {
  const baseApp = createNewsApp(dependencies);
  let app = baseApp;
  let honoxInitialized = false;
  const getApp = () => {
    if (options.useHonoxApp && !honoxInitialized) {
      app = createApp({ app: baseApp });
      honoxInitialized = true;
    }
    return app;
  };
  return {
    fetch: ((request, env, context) =>
      getApp().fetch(
        request as unknown as globalThis.Request,
        env,
        context as unknown as globalThis.ExecutionContext,
      ) as unknown as globalThis.Response) as NonNullable<ExportedHandler<WorkerBindings>["fetch"]>,
    scheduled: async (controller, env) => {
      const updater = dependencies.updater ?? updateNewsArchive;
      const logger = dependencies.logger ?? defaultLogger;
      const heartbeatFetcher = dependencies.heartbeatFetcher ?? fetch;
      await sendHeartbeat(env.HEALTHCHECKS_PING_URL, "heartbeat-start", heartbeatFetcher, logger);
      try {
        await updater({
          dataBucket: env.KF3_NOTIF_DATA,
          backupBucket: env.KF3_NOTIF_BACKUP,
          cache: env.KF3_NOTIF_CACHE,
          fetcher: dependencies.fetcher ?? fetch,
          nowMs: controller.scheduledTime,
          logger,
        });
      } catch (error) {
        await sendHeartbeat(env.HEALTHCHECKS_PING_URL, "heartbeat-fail", heartbeatFetcher, logger);
        throw error;
      }
      await sendHeartbeat(env.HEALTHCHECKS_PING_URL, "heartbeat-success", heartbeatFetcher, logger);
    },
  };
};

const worker = createWorkerHandler({}, { useHonoxApp: true });

export default worker;
