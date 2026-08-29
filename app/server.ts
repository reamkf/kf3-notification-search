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
  readOfficialCheckState,
  readOfficialFetchEligibility,
  serializeArchiveErrorForLog,
  updateNewsArchive,
  updateOfficialCheckState,
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
  NEWS_REFRESH_COOLDOWN_MS,
  NEWS_REFRESH_FINALIZATION_LEASE_MS,
  type NewsRefreshAcquireResult,
  type NewsRefreshLease,
} from "./news-refresh-control";
import {
  NEWS_DATA_VERSION_HEADER,
  applyNewsRefreshState,
  createNewsCacheMetadata,
  createNewsRefreshState,
  createNewsResponseHeaders,
  isReusableNewsCacheMetadata,
  parseNewsRefreshState,
  type NewsCacheMetadata,
  type NewsCacheMetadataV2,
} from "./news-response-metadata";
import {
  NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY,
  NEWS_CACHE_KEY,
  NEWS_REFRESH_STATE_KEY,
} from "./news-cache-keys";

const oldNewsPath = `/${LEGACY_ARCHIVE_KEY}`;
const cacheKey = NEWS_CACHE_KEY;
const refreshStateKey = NEWS_REFRESH_STATE_KEY;
const archiveSnapshotCacheKey = NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY;
const newsCacheExpirationTtl = 24 * 60 * 60;
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

const getWorkerVersionId = (env: WorkerBindings) => env.CF_VERSION_METADATA?.id ?? null;

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

const createRefreshErrorLog = (
  error: unknown,
  archiveCount: number | null = null,
  workerVersionId: string | null = null,
) => ({
  event: "news_refresh_failed",
  stage: getErrorStage(error),
  error: "お知らせ更新に失敗しました",
  originalError: serializeArchiveErrorForLog(error),
  archiveCount,
  workerVersionId,
});

const refreshPath = "/api/kf3-news/refresh";

const createJsonResponse = (json: string, metadata?: NewsCacheMetadata) => {
  const headers = createNewsResponseHeaders(metadata);
  headers.set("cache-control", "no-store");
  return new Response(json, { headers });
};

const createRefreshResponse = (
  clientJson: string,
  metadata: NewsCacheMetadataV2,
  clientDataVersion: string | null,
  refreshAvailableAt: string | null,
) => {
  const dataUnchanged =
    isReusableNewsCacheMetadata(metadata) &&
    clientDataVersion !== null &&
    metadata.baseArchiveEtag === clientDataVersion;
  const responseMetadata = { ...metadata, refreshAvailableAt };
  const bodyMetadata = { ...responseMetadata, fetchedAt: metadata.officialCheckedAt };
  const body = dataUnchanged
    ? `{"changed":false,"metadata":${JSON.stringify(bodyMetadata)}}`
    : `{"news":${clientJson},"metadata":${JSON.stringify(bodyMetadata)}}`;
  const response = createJsonResponse(body, responseMetadata);
  response.headers.set("vary", NEWS_DATA_VERSION_HEADER);
  return response;
};

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

type NewsApiMeasurements = {
  primaryCacheReadDurationMs: number;
  refreshStateReadDurationMs: number;
  snapshotCacheReadDurationMs: number;
  archiveReadDurationMs: number;
  officialCheckStateReadDurationMs: number;
};

type NewsApiDataSource = "merged-kv" | "snapshot-kv" | "r2";

type RefreshNewsResult = RefreshDurations & {
  officialFetchCount: number;
  clientJson: string;
  newsCount: number;
  currentEtag: string | null;
  currentExists: boolean;
  officialCheckedAt: string;
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

const measureNewsApiOperation = async <T>(
  measurements: NewsApiMeasurements,
  field: keyof NewsApiMeasurements,
  operation: () => Promise<T>,
): Promise<T> => {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    measurements[field] += performance.now() - startedAt;
  }
};

const logNewsApiSuccess = (
  logger: ArchiveLogger,
  env: WorkerBindings,
  dataSource: NewsApiDataSource,
  measurements: NewsApiMeasurements,
  startedAt: number,
) => {
  logger.log({
    event: "news_api_succeeded",
    dataSource,
    ...measurements,
    totalDurationMs: performance.now() - startedAt,
    workerVersionId: getWorkerVersionId(env),
  });
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
    measureOfficialFetch(measurements, dependencies.fetcher ?? fetch, {
      clock: dependencies.clock,
    }),
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
    officialCheckedAt: officialResult.value.checkedAt,
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
    clock: dependencies.clock,
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
        officialCheckedAt: official.checkedAt,
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
        officialCheckedAt: official.checkedAt,
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
    officialCheckedAt: official.checkedAt,
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
    const startedAt = performance.now();
    const measurements: NewsApiMeasurements = {
      primaryCacheReadDurationMs: 0,
      refreshStateReadDurationMs: 0,
      snapshotCacheReadDurationMs: 0,
      archiveReadDurationMs: 0,
      officialCheckStateReadDurationMs: 0,
    };
    try {
      const [cachedNews, refreshStateJson] = await Promise.all([
        measureNewsApiOperation(measurements, "primaryCacheReadDurationMs", () =>
          context.env.KF3_NOTIF_CACHE.getWithMetadata<NewsCacheMetadata>(cacheKey),
        ),
        measureNewsApiOperation(measurements, "refreshStateReadDurationMs", () =>
          context.env.KF3_NOTIF_CACHE.get(refreshStateKey).catch(() => null),
        ),
      ]);
      const refreshState = parseNewsRefreshState(refreshStateJson);
      if (cachedNews.value !== null) {
        const metadata = applyNewsRefreshState(cachedNews.metadata, refreshState);
        const response = createJsonResponse(cachedNews.value, metadata);
        logNewsApiSuccess(logger, context.env, "merged-kv", measurements, startedAt);
        return response;
      }

      const cachedArchiveSnapshot = await measureNewsApiOperation(
        measurements,
        "snapshotCacheReadDurationMs",
        () =>
          context.env.KF3_NOTIF_CACHE.getWithMetadata<NewsCacheMetadata>(archiveSnapshotCacheKey),
      );
      if (cachedArchiveSnapshot.value !== null) {
        const metadata = applyNewsRefreshState(cachedArchiveSnapshot.metadata, refreshState);
        const response = createJsonResponse(cachedArchiveSnapshot.value, metadata);
        logNewsApiSuccess(logger, context.env, "snapshot-kv", measurements, startedAt);
        return response;
      }

      const [snapshot, checkState] = await Promise.all([
        measureNewsApiOperation(measurements, "archiveReadDurationMs", () =>
          readArchiveSnapshot(context.env),
        ),
        measureNewsApiOperation(measurements, "officialCheckStateReadDurationMs", () =>
          readOfficialCheckState(context.env.KF3_NOTIF_DATA),
        ),
      ]);
      archiveCount = snapshot.clientNews.length;
      const responseJson = JSON.stringify(snapshot.clientNews);
      const officialCheckedAt = checkState.state?.checkedAt ?? null;
      const metadata = createNewsCacheMetadata(
        "archive-snapshot",
        officialCheckedAt,
        snapshot.archive.etag,
        archiveCount,
      );
      const responseMetadata =
        applyNewsRefreshState(metadata, parseNewsRefreshState(refreshStateJson)) ?? metadata;
      const response = createJsonResponse(responseJson, responseMetadata);
      context.executionCtx.waitUntil(
        (async () => {
          let snapshotWasWritten = false;
          try {
            await context.env.KF3_NOTIF_CACHE.put(archiveSnapshotCacheKey, responseJson, {
              expirationTtl: newsCacheExpirationTtl,
              metadata: responseMetadata,
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
      logNewsApiSuccess(logger, context.env, "r2", measurements, startedAt);
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
    let refreshCoordinator: ReturnType<
      WorkerBindings["KF3_REFRESH_COORDINATOR"]["getByName"]
    > | null = null;
    const clientDataVersion = context.req.header(NEWS_DATA_VERSION_HEADER) || null;
    let cachePutDurationMs = 0;
    let refreshStatePutDurationMs = 0;
    let currentEtagCheckDurationMs = 0;
    let leaseCompletionDurationMs = 0;
    const refreshStartedAt = performance.now();
    try {
      refreshCoordinator = context.env.KF3_REFRESH_COORDINATOR.getByName("kf3-news");
      const leaseAcquireStartedAt = performance.now();
      const acquired = await refreshCoordinator.acquire(dependencies.clock?.() ?? Date.now());
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
          workerVersionId: getWorkerVersionId(context.env),
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
        const leaseRenewal = await refreshCoordinator!.renew(
          lease.leaseToken,
          nowMs,
          NEWS_REFRESH_FINALIZATION_LEASE_MS,
        );
        if (typeof leaseRenewal === "string") return createRefreshLeaseExpiredResponse();
        lease = leaseRenewal;
      }

      const reusableArchiveEtag =
        result.currentExists && result.addedCount === 0 && result.updatedCount === 0
          ? result.currentEtag
          : null;
      const cacheRefreshAvailableAt = new Date(nowMs + NEWS_REFRESH_COOLDOWN_MS).toISOString();
      const metadata = createNewsCacheMetadata(
        "merged",
        result.officialCheckedAt,
        reusableArchiveEtag,
        result.newsCount,
      );
      const refreshState = createNewsRefreshState(
        reusableArchiveEtag,
        result.officialCheckedAt,
        cacheRefreshAvailableAt,
      );
      const shouldWriteNewsData = result.refreshDataSource !== "kv";
      let newsDataWasWritten = false;
      let refreshStateWasWritten = false;
      const deleteWrittenCache = async () => {
        if (!newsDataWasWritten) return;
        try {
          await context.env.KF3_NOTIF_CACHE.delete(cacheKey);
        } catch (cleanupError) {
          logger.error({
            event: "news_refresh_cache_cleanup_failed",
            originalError: serializeArchiveErrorForLog(cleanupError),
          });
        }
      };
      const deleteWrittenRefreshState = async () => {
        if (!refreshStateWasWritten) return;
        try {
          await context.env.KF3_NOTIF_CACHE.delete(refreshStateKey);
        } catch (cleanupError) {
          logger.error({
            event: "news_refresh_cache_cleanup_failed",
            key: refreshStateKey,
            originalError: serializeArchiveErrorForLog(cleanupError),
          });
        }
      };
      try {
        if (shouldWriteNewsData) {
          const cachePutStartedAt = performance.now();
          try {
            await context.env.KF3_NOTIF_CACHE.put(cacheKey, result.clientJson, {
              expirationTtl: newsCacheExpirationTtl,
              metadata: createNewsCacheMetadata(
                "merged",
                null,
                reusableArchiveEtag,
                result.newsCount,
              ),
            });
            newsDataWasWritten = true;
          } finally {
            cachePutDurationMs = performance.now() - cachePutStartedAt;
          }

          const currentEtagCheckStartedAt = performance.now();
          let currentEtag: string | null;
          try {
            currentEtag =
              (await context.env.KF3_NOTIF_DATA.head(CURRENT_ARCHIVE_KEY))?.etag ?? null;
          } finally {
            currentEtagCheckDurationMs = performance.now() - currentEtagCheckStartedAt;
          }
          if ((result.currentEtag ?? null) !== currentEtag) {
            throw new NewsArchiveError("etag-conflict", "refreshのKV保存中にcurrentが競合しました");
          }
        }

        const refreshStatePutStartedAt = performance.now();
        try {
          await context.env.KF3_NOTIF_CACHE.put(refreshStateKey, JSON.stringify(refreshState), {
            expirationTtl: newsCacheExpirationTtl,
          });
          refreshStateWasWritten = true;
        } finally {
          refreshStatePutDurationMs = performance.now() - refreshStatePutStartedAt;
        }
      } catch (error) {
        await deleteWrittenCache();
        throw error;
      }
      let leaseCompletion: string;
      let refreshAvailableAt: string | null = null;
      const leaseCompletionNowMs = dependencies.clock?.() ?? Date.now();
      const leaseCompletionStartedAt = performance.now();
      try {
        leaseCompletion = await refreshCoordinator!.complete(
          lease.leaseToken,
          "success",
          leaseCompletionNowMs,
        );
        if (leaseCompletion === "updated") {
          refreshAvailableAt = new Date(
            leaseCompletionNowMs + NEWS_REFRESH_COOLDOWN_MS,
          ).toISOString();
        }
      } catch (error) {
        logger.error({
          event: "news_refresh_control_completion_failed",
          originalError: serializeArchiveErrorForLog(error),
        });
        await Promise.all([deleteWrittenCache(), deleteWrittenRefreshState()]);
        throw error;
      } finally {
        leaseCompletionDurationMs = performance.now() - leaseCompletionStartedAt;
      }
      if (leaseCompletion === "lease-mismatch") {
        return createRefreshLeaseExpiredResponse();
      }
      let officialCheckStateStatus: "scheduled" | "schedule-failed" = "scheduled";
      try {
        context.executionCtx.waitUntil(
          updateOfficialCheckState(context.env.KF3_NOTIF_DATA, result.officialCheckedAt)
            .then((status) =>
              logger.log({
                event: "news_official_check_state_updated",
                officialCheckedAt: result.officialCheckedAt,
                status,
              }),
            )
            .catch((error) => {
              logger.error({
                event: "news_official_check_state_update_failed",
                originalError: serializeArchiveErrorForLog(error),
              });
            }),
        );
      } catch (error) {
        officialCheckStateStatus = "schedule-failed";
        logger.error({
          event: "news_official_check_state_update_failed",
          originalError: serializeArchiveErrorForLog(error),
        });
      }
      const requiresInitialization = !result.currentExists;
      const archiveChanged = result.addedCount > 0 || result.updatedCount > 0;
      const archiveUpdateNeeded = requiresInitialization || archiveChanged;
      let archiveUpdateQueueStatus: "not-needed" | "scheduled" | "schedule-failed" = "not-needed";
      if (archiveUpdateNeeded) {
        const message: NewsArchiveUpdateMessage = {
          version: NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION,
          reason: requiresInitialization ? "refresh-current-missing" : "refresh-detected-change",
          detectedAt: result.officialCheckedAt,
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
        workerVersionId: getWorkerVersionId(context.env),
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
        officialCheckedAt: result.officialCheckedAt,
        officialCheckStateStatus,
        refreshDataSource: result.refreshDataSource,
        refreshLeaseAcquireDurationMs,
        refreshEligibilityDurationMs: result.refreshEligibilityDurationMs,
        refreshFetchDurationMs,
        officialFetchDurationMs: result.officialFetchDurationMs,
        refreshCacheReadDurationMs: result.refreshCacheReadDurationMs,
        archiveReadDurationMs: result.archiveReadDurationMs,
        newsDataWritten: shouldWriteNewsData,
        cachePutDurationMs,
        refreshStatePutDurationMs,
        currentEtagCheckDurationMs,
        leaseCompletionDurationMs,
        refreshFinalizationDurationMs: performance.now() - refreshFinalizationStartedAt,
        refreshTotalDurationMs: performance.now() - refreshStartedAt,
      });
      return createRefreshResponse(
        result.clientJson,
        metadata,
        clientDataVersion,
        refreshAvailableAt,
      );
    } catch (error) {
      const workerVersionId = getWorkerVersionId(context.env);
      logger.error(createRefreshErrorLog(error, archiveCount, workerVersionId));
      if (lease !== null) {
        try {
          await refreshCoordinator!.complete(
            lease.leaseToken,
            "failure",
            dependencies.clock?.() ?? Date.now(),
          );
        } catch (completionError) {
          logger.error(createRefreshErrorLog(completionError, archiveCount, workerVersionId));
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
    clock: dependencies.clock,
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
