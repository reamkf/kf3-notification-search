import type { ExportedHandler } from "@cloudflare/workers-types";
import { Hono } from "hono";
import type { Context } from "hono";
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
  NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION,
  isNewsArchiveUpdateMessage,
  type NewsArchiveUpdateMessage,
} from "./news-archive-queue";
import {
  NewsDataError,
  mergeValidatedNewsDocument,
  projectValidatedClientNews,
  type ValidatedNewsMergeResult,
} from "./news-data";
import {
  NEWS_REFRESH_FINALIZATION_LEASE_MS,
  acquireNewsRefreshLease,
  completeNewsRefreshLease,
  renewNewsRefreshLease,
  type NewsRefreshAcquireResult,
  type NewsRefreshLease,
} from "./news-refresh-control";
import {
  createNewsCacheMetadata,
  createNewsResponseHeaders,
  isReusableNewsCacheMetadata,
  type NewsCacheMetadata,
} from "./news-response-metadata";
import { NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY, NEWS_CACHE_KEY } from "./news-cache-keys";

const oldNewsPath = `/${LEGACY_ARCHIVE_KEY}`;
const cacheKey = NEWS_CACHE_KEY;
const archiveSnapshotCacheKey = NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY;
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
    throw new Error("旧お知らせデータがR2に見つかりません");
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
  error: "お知らせAPI処理に失敗しました",
  originalError: serializeArchiveErrorForLog(error),
  archiveCount,
});

const createRefreshErrorLog = (error: unknown, archiveCount: number | null = null) => ({
  event: "news_refresh_failed",
  stage: getErrorStage(error),
  error: "お知らせ更新に失敗しました",
  originalError: serializeArchiveErrorForLog(error),
  archiveCount,
});

const refreshPath = "/api/kf3-news/refresh";

const createJsonResponse = (json: string, metadata?: NewsCacheMetadata) => {
  const headers = createNewsResponseHeaders(metadata);
  headers.set("cache-control", "no-store");
  return new Response(json, { headers });
};

const createRefreshResponse = (clientJson: string, metadata: NewsCacheMetadata) =>
  createJsonResponse(`{"news":${clientJson},"metadata":${JSON.stringify(metadata)}}`, metadata);

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

const serializeClientNews = (news: ReturnType<typeof projectValidatedClientNews>) => ({
  clientJson: JSON.stringify(news),
  newsCount: news.length,
});

type RefreshDurations = {
  refreshEligibilityDurationMs: number;
  officialFetchDurationMs: number;
  refreshCacheReadDurationMs: number;
  archiveReadDurationMs: number;
};

type RefreshMeasurements = RefreshDurations & {
  officialFetchCount: number;
  officialFetchStatus: "modified" | "not-modified" | null;
  refreshDataSource: "kv" | "current" | "full-merge" | null;
};

type RefreshNewsResult = RefreshDurations & {
  officialFetchCount: number;
  clientJson: string;
  newsCount: number;
  currentEtag: string | null;
  currentExists: boolean;
  addedCount: number;
  updatedCount: number;
  officialFetchStatus: "modified" | "not-modified";
  refreshDataSource: "kv" | "current" | "full-merge";
};

const measureRefreshOperation = async <T>(
  durations: RefreshDurations,
  field: keyof RefreshDurations,
  operation: () => Promise<T>,
): Promise<T> => {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    durations[field] += performance.now() - startedAt;
  }
};

const measureOfficialFetch = (
  measurements: RefreshMeasurements,
  fetcher: NewsFetcher,
  options?: Parameters<typeof fetchOfficialNews>[1],
) => {
  measurements.officialFetchCount += 1;
  return measureRefreshOperation(measurements, "officialFetchDurationMs", () =>
    fetchOfficialNews(fetcher, options),
  );
};

const getRefreshNewsUnconditionally = async (
  env: WorkerBindings,
  dependencies: ServerDependencies,
  measurements: RefreshMeasurements,
): Promise<RefreshNewsResult> => {
  const [archiveResult, officialResult] = await Promise.allSettled([
    measureRefreshOperation(measurements, "archiveReadDurationMs", () =>
      readArchiveDocument(env.KF3_NOTIF_DATA),
    ),
    measureOfficialFetch(measurements, dependencies.fetcher ?? fetch),
  ]);
  if (archiveResult.status === "rejected") throw archiveResult.reason;
  if (officialResult.status === "rejected") throw officialResult.reason;
  measurements.officialFetchStatus = officialResult.value.status;
  measurements.refreshDataSource = "full-merge";
  if (officialResult.value.status !== "modified") {
    throw new NewsArchiveError("official-fetch", "公式お知らせの応答形式が不正です");
  }
  const merged = mergeValidatedNewsDocument(
    archiveResult.value.document,
    officialResult.value.document,
    {
      validateOfficialEntries: true,
    },
  );
  return {
    ...measurements,
    ...serializeClientNews(projectValidatedClientNews(merged.document)),
    currentEtag: archiveResult.value.etag,
    currentExists: archiveResult.value.currentExists,
    addedCount: merged.stats.addedCount,
    updatedCount: merged.stats.updatedCount,
    officialFetchStatus: "modified",
    refreshDataSource: "full-merge",
  };
};

const getRefreshNews = async (
  env: WorkerBindings,
  dependencies: ServerDependencies,
): Promise<RefreshNewsResult> => {
  const measurements: RefreshMeasurements = {
    refreshEligibilityDurationMs: 0,
    officialFetchCount: 0,
    officialFetchDurationMs: 0,
    refreshCacheReadDurationMs: 0,
    archiveReadDurationMs: 0,
    officialFetchStatus: null,
    refreshDataSource: null,
  };
  const eligibility = await measureRefreshOperation(
    measurements,
    "refreshEligibilityDurationMs",
    () => readOfficialFetchEligibility(env.KF3_NOTIF_DATA),
  );
  if (!eligibility.ifNoneMatch)
    return getRefreshNewsUnconditionally(env, dependencies, measurements);

  const official = await measureOfficialFetch(measurements, dependencies.fetcher ?? fetch, {
    ifNoneMatch: eligibility.ifNoneMatch!,
  });
  measurements.officialFetchStatus = official.status;
  if (official.status === "not-modified") {
    const cached = await measureRefreshOperation(measurements, "refreshCacheReadDurationMs", () =>
      env.KF3_NOTIF_CACHE.getWithMetadata<NewsCacheMetadata>(cacheKey),
    );
    if (
      cached.value !== null &&
      isReusableNewsCacheMetadata(cached.metadata) &&
      cached.metadata.baseArchiveEtag === eligibility.currentEtag
    ) {
      return {
        ...measurements,
        clientJson: cached.value,
        newsCount: cached.metadata.newsCount,
        currentEtag: eligibility.currentEtag,
        currentExists: true,
        addedCount: 0,
        updatedCount: 0,
        officialFetchStatus: "not-modified",
        refreshDataSource: "kv",
      };
    }

    const current = await measureRefreshOperation(measurements, "archiveReadDurationMs", () =>
      readCurrentArchiveDocumentIfEtag(env.KF3_NOTIF_DATA, eligibility.currentEtag ?? ""),
    );
    if (current) {
      return {
        ...measurements,
        ...serializeClientNews(projectValidatedClientNews(current.document)),
        currentEtag: current.etag,
        currentExists: true,
        addedCount: 0,
        updatedCount: 0,
        officialFetchStatus: "not-modified",
        refreshDataSource: "current",
      };
    }
    return getRefreshNewsUnconditionally(env, dependencies, measurements);
  }

  const archive = await measureRefreshOperation(measurements, "archiveReadDurationMs", () =>
    readArchiveDocument(env.KF3_NOTIF_DATA),
  );
  const merged: ValidatedNewsMergeResult = mergeValidatedNewsDocument(
    archive.document,
    official.document,
    {
      validateOfficialEntries: true,
    },
  );
  return {
    ...measurements,
    ...serializeClientNews(projectValidatedClientNews(merged.document)),
    currentEtag: archive.etag,
    currentExists: archive.currentExists,
    addedCount: merged.stats.addedCount,
    updatedCount: merged.stats.updatedCount,
    officialFetchStatus: "modified",
    refreshDataSource: "full-merge",
  };
};

const getRetryHeaders = (retryAfterSeconds: number) =>
  new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": String(retryAfterSeconds),
  });

const createRefreshLeaseExpiredResponse = () =>
  new Response(JSON.stringify({ error: "お知らせ更新のleaseが失効しました" }), {
    status: 202,
    headers: getRetryHeaders(1),
  });

const createRefreshBusyResponse = (
  result: Exclude<NewsRefreshAcquireResult, { status: "acquired" }>,
) => {
  const headers = getRetryHeaders(result.retryAfterSeconds);
  const body =
    result.status === "running"
      ? { error: "お知らせ更新が実行中です", leaseUntil: result.leaseUntil }
      : { error: "お知らせ更新はクールダウン中です", nextAvailableAt: result.nextAvailableAt };
  if (result.status === "cooldown") {
    headers.set("x-kf3-news-refresh-next-available-at", result.nextAvailableAt);
  }
  return new Response(JSON.stringify(body), {
    status: result.status === "running" ? 202 : 429,
    headers,
  });
};

export const createNewsApp = (dependencies: ServerDependencies) => {
  const baseApp = new Hono<{ Bindings: WorkerBindings; Variables: {} }>();
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

      const cachedArchiveSnapshot =
        await context.env.KF3_NOTIF_CACHE.getWithMetadata<NewsCacheMetadata>(
          archiveSnapshotCacheKey,
        );
      if (cachedArchiveSnapshot.value !== null)
        return createJsonResponse(
          cachedArchiveSnapshot.value,
          cachedArchiveSnapshot.metadata ?? undefined,
        );

      const snapshot = await readArchiveSnapshot(context.env);
      archiveCount = snapshot.clientNews.length;
      const fetchedAt = new Date(dependencies.clock?.() ?? Date.now()).toISOString();
      const responseJson = JSON.stringify(snapshot.clientNews);
      const metadata = createNewsCacheMetadata(
        "archive-snapshot",
        fetchedAt,
        snapshot.archive.etag,
        archiveCount,
      );
      const response = createJsonResponse(responseJson, metadata);
      context.executionCtx.waitUntil(
        (async () => {
          let snapshotWasWritten = false;
          try {
            await context.env.KF3_NOTIF_CACHE.put(archiveSnapshotCacheKey, responseJson, {
              expirationTtl: normalCacheTtl,
              metadata,
            });
            snapshotWasWritten = true;
            const current = await context.env.KF3_NOTIF_DATA.head(CURRENT_ARCHIVE_KEY);
            if ((snapshot.archive.etag ?? null) !== (current?.etag ?? null)) {
              await context.env.KF3_NOTIF_CACHE.delete(archiveSnapshotCacheKey);
            }
          } catch (error) {
            logger.error({
              event: "news_api_cache_write_failed",
              originalError: serializeArchiveErrorForLog(error),
              archiveCount,
            });
            if (snapshotWasWritten) {
              try {
                await context.env.KF3_NOTIF_CACHE.delete(archiveSnapshotCacheKey);
              } catch (cleanupError) {
                logger.error({
                  event: "news_api_cache_cleanup_failed",
                  originalError: serializeArchiveErrorForLog(cleanupError),
                  archiveCount,
                });
              }
            }
          }
        })(),
      );
      return response;
    } catch (error) {
      logger.error(createApiErrorLog(error, archiveCount));
      return context.json({ error: "お知らせデータの取得に失敗しました" }, 500);
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
    let lease: NewsRefreshLease | null = null;
    let cachePutDurationMs = 0;
    let currentEtagCheckDurationMs = 0;
    let leaseCompletionDurationMs = 0;
    const refreshStartedAt = performance.now();
    try {
      const leaseAcquireStartedAt = performance.now();
      const acquired = await acquireNewsRefreshLease(
        context.env.KF3_NOTIF_DATA,
        dependencies.clock?.() ?? Date.now(),
      );
      const refreshLeaseAcquireDurationMs = performance.now() - leaseAcquireStartedAt;
      if (acquired.status !== "acquired") {
        logger.error({
          event: "news_refresh_failed",
          stage: "refresh-control",
          error:
            acquired.status === "running"
              ? "お知らせ更新が実行中です"
              : "お知らせ更新はクールダウン中です",
          archiveCount,
          reason: acquired.status,
          retryAfterSeconds: acquired.retryAfterSeconds,
        });
        return createRefreshBusyResponse(acquired);
      }
      lease = acquired.lease;

      const refreshFetchStartedAt = performance.now();
      const result = await getRefreshNews(context.env, dependencies);
      const refreshFetchDurationMs = performance.now() - refreshFetchStartedAt;
      const refreshFinalizationStartedAt = performance.now();
      archiveCount = result.newsCount;
      const nowMs = dependencies.clock?.() ?? Date.now();
      const remainingLeaseMs = Date.parse(lease.leaseUntil) - nowMs;
      if (remainingLeaseMs < 20_000) {
        const leaseRenewal = await renewNewsRefreshLease(
          context.env.KF3_NOTIF_DATA,
          lease,
          nowMs,
          NEWS_REFRESH_FINALIZATION_LEASE_MS,
        );
        if (typeof leaseRenewal === "string") return createRefreshLeaseExpiredResponse();
        lease = leaseRenewal;
      }

      const fetchedAt = new Date(dependencies.clock?.() ?? Date.now()).toISOString();
      const reusableArchiveEtag =
        result.currentExists && result.addedCount === 0 && result.updatedCount === 0
          ? result.currentEtag
          : null;
      const metadata = createNewsCacheMetadata(
        "merged",
        fetchedAt,
        reusableArchiveEtag,
        result.newsCount,
      );
      const responseJson = result.clientJson;
      const cachePutStartedAt = performance.now();
      try {
        await context.env.KF3_NOTIF_CACHE.put(cacheKey, responseJson, {
          expirationTtl: normalCacheTtl,
          metadata,
        });
      } finally {
        cachePutDurationMs = performance.now() - cachePutStartedAt;
      }
      const deleteWrittenCache = async () => {
        try {
          await context.env.KF3_NOTIF_CACHE.delete(cacheKey);
        } catch (cleanupError) {
          logger.error({
            event: "news_refresh_cache_cleanup_failed",
            originalError: serializeArchiveErrorForLog(cleanupError),
          });
        }
      };
      try {
        const currentEtagCheckStartedAt = performance.now();
        let currentEtag: string | null;
        try {
          currentEtag = (await context.env.KF3_NOTIF_DATA.head(CURRENT_ARCHIVE_KEY))?.etag ?? null;
        } finally {
          currentEtagCheckDurationMs = performance.now() - currentEtagCheckStartedAt;
        }
        if ((result.currentEtag ?? null) !== currentEtag) {
          throw new NewsArchiveError("etag-conflict", "refreshのKV保存中にcurrentが競合しました");
        }
      } catch (error) {
        await deleteWrittenCache();
        throw error;
      }
      let leaseCompletion: string;
      const leaseCompletionStartedAt = performance.now();
      try {
        leaseCompletion = await completeNewsRefreshLease(
          context.env.KF3_NOTIF_DATA,
          lease,
          "success",
          dependencies.clock?.() ?? Date.now(),
        );
      } catch (error) {
        leaseCompletion = "error";
        logger.error({
          event: "news_refresh_control_completion_failed",
          originalError: serializeArchiveErrorForLog(error),
        });
      } finally {
        leaseCompletionDurationMs = performance.now() - leaseCompletionStartedAt;
      }
      if (leaseCompletion === "lease-mismatch") {
        return createRefreshLeaseExpiredResponse();
      }
      const requiresInitialization = !result.currentExists;
      const archiveChanged = result.addedCount > 0 || result.updatedCount > 0;
      const archiveUpdateNeeded = requiresInitialization || archiveChanged;
      let archiveUpdateQueueStatus: "not-needed" | "scheduled" | "schedule-failed" = "not-needed";
      if (archiveUpdateNeeded) {
        const message: NewsArchiveUpdateMessage = {
          version: NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION,
          reason: requiresInitialization ? "refresh-current-missing" : "refresh-detected-change",
          detectedAt: fetchedAt,
          addedCount: result.addedCount,
          updatedCount: result.updatedCount,
          requiresInitialization,
        };
        try {
          context.executionCtx.waitUntil(
            context.env.KF3_ARCHIVE_UPDATE_QUEUE.send(message)
              .then(() => logger.log({ event: "news_archive_update_queued", ...message }))
              .catch((error) => {
                logger.error({
                  event: "news_archive_update_enqueue_failed",
                  error: serializeArchiveErrorForLog(error),
                  addedCount: result.addedCount,
                  updatedCount: result.updatedCount,
                });
              }),
          );
          archiveUpdateQueueStatus = "scheduled";
        } catch (error) {
          archiveUpdateQueueStatus = "schedule-failed";
          logger.error({
            event: "news_archive_update_enqueue_failed",
            error: serializeArchiveErrorForLog(error),
            addedCount: result.addedCount,
            updatedCount: result.updatedCount,
          });
        }
      }
      logger.log({
        event: "news_refresh_succeeded",
        archiveCount,
        mergedCount: result.newsCount,
        addedCount: result.addedCount,
        updatedCount: result.updatedCount,
        requiresInitialization,
        archiveChanged,
        archiveUpdateNeeded,
        archiveUpdateQueueStatus,
        leaseCompletion,
        officialFetchCount: result.officialFetchCount,
        officialFetchStatus: result.officialFetchStatus,
        refreshDataSource: result.refreshDataSource,
        refreshLeaseAcquireDurationMs,
        refreshEligibilityDurationMs: result.refreshEligibilityDurationMs,
        refreshFetchDurationMs,
        officialFetchDurationMs: result.officialFetchDurationMs,
        refreshCacheReadDurationMs: result.refreshCacheReadDurationMs,
        archiveReadDurationMs: result.archiveReadDurationMs,
        cachePutDurationMs,
        currentEtagCheckDurationMs,
        leaseCompletionDurationMs,
        refreshFinalizationDurationMs: performance.now() - refreshFinalizationStartedAt,
        refreshTotalDurationMs: performance.now() - refreshStartedAt,
      });
      return createRefreshResponse(result.clientJson, metadata);
    } catch (error) {
      logger.error(createRefreshErrorLog(error, archiveCount));
      if (lease !== null) {
        try {
          await completeNewsRefreshLease(
            context.env.KF3_NOTIF_DATA,
            lease,
            "failure",
            dependencies.clock?.() ?? Date.now(),
          );
        } catch (completionError) {
          logger.error(createRefreshErrorLog(completionError, archiveCount));
        }
      }
      return context.json({ error: "お知らせ更新に失敗しました" }, 503);
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

const runArchiveUpdate = (
  env: WorkerBindings,
  dependencies: ServerDependencies,
  nowMs: number,
  trigger: "scheduled" | "queue",
) =>
  (dependencies.updater ?? updateNewsArchive)({
    dataBucket: env.KF3_NOTIF_DATA,
    backupBucket: env.KF3_NOTIF_BACKUP,
    cache: env.KF3_NOTIF_CACHE,
    fetcher: dependencies.fetcher ?? fetch,
    nowMs,
    logger: dependencies.logger ?? defaultLogger,
    trigger,
    invalidateDisplayCache: trigger !== "queue",
  });

export const createWorkerHandler = (
  dependencies: ServerDependencies = {},
): ExportedHandler<WorkerBindings, unknown> => {
  const app = createNewsApp(dependencies);
  return {
    fetch: ((request, env, context) =>
      app.fetch(
        request as unknown as globalThis.Request,
        env,
        context as unknown as globalThis.ExecutionContext,
      ) as unknown as globalThis.Response) as NonNullable<ExportedHandler<WorkerBindings>["fetch"]>,
    scheduled: async (controller, env) => {
      const logger = dependencies.logger ?? defaultLogger;
      const heartbeatFetcher = dependencies.heartbeatFetcher ?? fetch;
      await sendHeartbeat(env.HEALTHCHECKS_PING_URL, "heartbeat-start", heartbeatFetcher, logger);
      try {
        await runArchiveUpdate(env, dependencies, controller.scheduledTime, "scheduled");
      } catch (error) {
        await sendHeartbeat(env.HEALTHCHECKS_PING_URL, "heartbeat-fail", heartbeatFetcher, logger);
        throw error;
      }
      await sendHeartbeat(env.HEALTHCHECKS_PING_URL, "heartbeat-success", heartbeatFetcher, logger);
    },
    queue: async (batch, env) => {
      const logger = dependencies.logger ?? defaultLogger;
      for (const message of batch.messages) {
        if (!isNewsArchiveUpdateMessage(message.body)) {
          logger.error({
            event: "news_archive_queue_invalid_message",
            messageId: message.id,
          });
          message.ack();
          continue;
        }
        try {
          await runArchiveUpdate(env, dependencies, dependencies.clock?.() ?? Date.now(), "queue");
          logger.log({
            event: "news_archive_queue_succeeded",
            messageId: message.id,
            reason: message.body.reason,
            detectedAt: message.body.detectedAt,
            addedCount: message.body.addedCount,
            updatedCount: message.body.updatedCount,
            requiresInitialization: message.body.requiresInitialization,
          });
          message.ack();
        } catch (error) {
          logger.error({
            event: "news_archive_queue_failed",
            messageId: message.id,
            error: serializeArchiveErrorForLog(error),
          });
          message.retry({ delaySeconds: 60 });
        }
      }
    },
  };
};

const worker = createWorkerHandler();

export default worker;
