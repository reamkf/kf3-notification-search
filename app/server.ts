import type { ExportedHandler } from "@cloudflare/workers-types";
import { createHono } from "honox/factory";
import { createApp } from "honox/server";
import {
  LEGACY_ARCHIVE_KEY,
  NewsArchiveError,
  fetchOfficialNews,
  readArchiveDocument,
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

const oldNewsPath = `/${LEGACY_ARCHIVE_KEY}`;
const cacheKey = "kf3-news";
const normalCacheTtl = 60 * 5;
const fallbackCacheTtl = 60;
const heartbeatTimeoutMs = 10_000;
const jsonContentType = "application/json; charset=UTF-8";

export type ServerDependencies = {
  fetcher?: NewsFetcher;
  heartbeatFetcher?: typeof fetch;
  updater?: (dependencies: NewsArchiveUpdateDependencies) => Promise<unknown>;
  logger?: ArchiveLogger;
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
  error: error instanceof Error ? error.message : "ニュースAPI処理に失敗しました",
  archiveCount,
});

const createFallbackLog = (error: unknown, archiveCount: number) => ({
  event: "news_api_fallback",
  stage: getErrorStage(error),
  error: error instanceof Error ? error.message : "公式ニュース処理に失敗しました",
  archiveCount,
});

const createJsonResponse = (json: string) =>
  new Response(json, { headers: { "content-type": jsonContentType } });

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

const getMergedClientNews = async (
  env: WorkerBindings,
  dependencies: ServerDependencies,
  logger: ArchiveLogger,
) => {
  const [archiveResult, officialResult] = await Promise.allSettled([
    readArchiveDocument(env.KF3_NOTIF_DATA),
    fetchOfficialNews(dependencies.fetcher ?? fetch),
  ]);
  if (archiveResult.status === "rejected") throw archiveResult.reason;
  const archive = archiveResult.value;

  if (officialResult.status === "rejected") {
    const clientNews = projectValidatedClientNews(archive.document);
    logger.error(createFallbackLog(officialResult.reason, clientNews.length));
    return { clientNews, expirationTtl: fallbackCacheTtl };
  }

  let merged: ValidatedNewsMergeResult;
  try {
    merged = mergeValidatedNewsDocument(archive.document, officialResult.value.document, {
      validateOfficialEntries: true,
    });
  } catch (error) {
    const clientNews = projectValidatedClientNews(archive.document);
    logger.error(createFallbackLog(error, clientNews.length));
    return { clientNews, expirationTtl: fallbackCacheTtl };
  }
  return {
    clientNews: projectValidatedClientNews(merged.document),
    expirationTtl: normalCacheTtl,
  };
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
      const cachedNewsData = await context.env.KF3_NOTIF_CACHE.get(cacheKey);
      if (cachedNewsData !== null) return createJsonResponse(cachedNewsData);

      const result = await getMergedClientNews(context.env, dependencies, logger);
      archiveCount = result.clientNews.length;
      const responseJson = JSON.stringify(result.clientNews);
      await context.env.KF3_NOTIF_CACHE.put(cacheKey, responseJson, {
        expirationTtl: result.expirationTtl,
      });
      return createJsonResponse(responseJson);
    } catch (error) {
      logger.error(createApiErrorLog(error, archiveCount));
      return context.json({ error: "ニュースデータの取得に失敗しました" }, 500);
    }
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
