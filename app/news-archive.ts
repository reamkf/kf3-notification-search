import type {
  KVNamespace,
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from "@cloudflare/workers-types/experimental";
import {
  MAX_OFFICIAL_RESPONSE_BYTES,
  OFFICIAL_NEWS_ORIGIN,
  NewsDataError,
  mergeValidatedNewsDocument,
  serializeSortedNewsDocument,
  validateParsedOfficialNewsDocumentShape,
  validateParsedStoredNewsDocumentShape,
} from "./news-data";
import type { StoredNewsDocument } from "./schema";

export const OFFICIAL_NEWS_URL = `${OFFICIAL_NEWS_ORIGIN}/info/all/entries.txt`;
export const OFFICIAL_FETCH_TIMEOUT_MS = 10_000;
export const CURRENT_ARCHIVE_KEY = "archive/current.json";
export const LEGACY_ARCHIVE_KEY = "entries_merged_20241107.json";
export { MAX_OFFICIAL_RESPONSE_BYTES } from "./news-data";

export type NewsFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class NewsArchiveError extends Error {
  readonly stage: string;
  readonly details: Record<string, unknown>;

  constructor(stage: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "NewsArchiveError";
    this.stage = stage;
    this.details = details;
  }
}

export type ArchiveReadResult = {
  document: StoredNewsDocument;
  text: string;
  sourceKey: string;
  etag: string | null;
  currentExists: boolean;
};

export type ArchiveDocumentReadResult = {
  document: StoredNewsDocument;
  sourceKey: string;
  etag: string | null;
  currentExists: boolean;
};

const ORIGINAL_ERROR_NAME_MAX_LENGTH = 100;
const ORIGINAL_ERROR_MESSAGE_MAX_LENGTH = 500;
const REDACTED_VALUE = "[REDACTED]";
const REDACTED_TOKEN = "[REDACTED_TOKEN]";
const REDACTED_URL = "[REDACTED_URL]";

const truncateLogValue = (value: string, maxLength: number) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

const sanitizeLogValue = (value: string, maxLength: number, fallback: string) => {
  const normalized = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const sanitized = normalized
    .replace(/\b(?:https?|wss?):\/\/[^\s]+/giu, REDACTED_URL)
    .replace(
      /\b(proxy-authorization|authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu,
      `$1: ${REDACTED_VALUE}`,
    )
    .replace(/\bbearer\s+[a-z0-9._~+/-]+=*/giu, `Bearer ${REDACTED_VALUE}`)
    .replace(
      /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|client[-_]?secret|token|secret|password|passwd)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      `$1=${REDACTED_VALUE}`,
    )
    .replace(/\b[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/giu, REDACTED_TOKEN)
    .replace(/\b(?:github_pat_|gh[pousr]_|xox[baprs]-|sk-)[a-z0-9_-]+\b/giu, REDACTED_TOKEN);
  return truncateLogValue(sanitized || fallback, maxLength);
};

const serializeOriginalError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return {
      name: "NonErrorThrown",
      message: "A non-Error value was thrown",
    };
  }

  let name = "Error";
  let message = "Error message unavailable";
  try {
    const errorName = error.name;
    if (typeof errorName === "string") name = errorName;
  } catch {
    name = "Error";
  }
  try {
    const errorMessage = error.message;
    if (typeof errorMessage === "string") message = errorMessage;
  } catch {
    message = "Error message unavailable";
  }

  return {
    name: sanitizeLogValue(name, ORIGINAL_ERROR_NAME_MAX_LENGTH, "Error"),
    message: sanitizeLogValue(
      message,
      ORIGINAL_ERROR_MESSAGE_MAX_LENGTH,
      "Error message unavailable",
    ),
  };
};

const createArchiveReadError = (error: unknown, details: Record<string, unknown> = {}) => {
  if (error instanceof NewsArchiveError) return error;
  if (error instanceof NewsDataError) {
    return new NewsArchiveError("archive-read", error.message, {
      ...details,
      dataStage: error.stage,
      dataDetails: error.details,
    });
  }
  return new NewsArchiveError("archive-read", "アーカイブの読み込みに失敗しました", {
    ...details,
    originalError: serializeOriginalError(error),
  });
};

const readObjectText = async (object: R2ObjectBody, sourceKey: string) => {
  try {
    return await object.text();
  } catch (error) {
    throw createArchiveReadError(error, { sourceKey });
  }
};

type ArchiveSource = {
  text: string;
  sourceKey: string;
  etag: string | null;
  currentExists: boolean;
};

const readArchiveSource = async (bucket: R2Bucket): Promise<ArchiveSource> => {
  let currentObject;
  try {
    currentObject = await bucket.get(CURRENT_ARCHIVE_KEY);
  } catch (error) {
    throw createArchiveReadError(error, { sourceKey: CURRENT_ARCHIVE_KEY });
  }

  if (currentObject) {
    return {
      text: await readObjectText(currentObject, CURRENT_ARCHIVE_KEY),
      sourceKey: CURRENT_ARCHIVE_KEY,
      etag: currentObject.etag,
      currentExists: true,
    };
  }

  let legacyObject;
  try {
    legacyObject = await bucket.get(LEGACY_ARCHIVE_KEY);
  } catch (error) {
    throw createArchiveReadError(error, { sourceKey: LEGACY_ARCHIVE_KEY });
  }
  if (!legacyObject) {
    throw new NewsArchiveError("archive-read", "累積アーカイブが見つかりません", {
      sourceKey: LEGACY_ARCHIVE_KEY,
    });
  }

  return {
    text: await readObjectText(legacyObject, LEGACY_ARCHIVE_KEY),
    sourceKey: LEGACY_ARCHIVE_KEY,
    etag: null,
    currentExists: false,
  };
};

const parseArchiveText = (text: string, sourceKey: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NewsArchiveError("archive-read", "アーカイブJSONの解析に失敗しました", { sourceKey });
  }

  try {
    return validateParsedStoredNewsDocumentShape(parsed);
  } catch (error) {
    throw createArchiveReadError(error, { sourceKey });
  }
};

export const readArchive = async (bucket: R2Bucket): Promise<ArchiveReadResult> => {
  const source = await readArchiveSource(bucket);
  return {
    document: parseArchiveText(source.text, source.sourceKey),
    text: source.text,
    sourceKey: source.sourceKey,
    etag: source.etag,
    currentExists: source.currentExists,
  };
};

export const readNewsArchive = readArchive;

export const readArchiveDocument = async (bucket: R2Bucket): Promise<ArchiveDocumentReadResult> => {
  const archive = await readArchive(bucket);
  return {
    document: archive.document,
    sourceKey: archive.sourceKey,
    etag: archive.etag,
    currentExists: archive.currentExists,
  };
};

const parseContentLength = (value: string | null): number | null => {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) {
    throw new NewsArchiveError("official-fetch", "Content-Lengthが不正です");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new NewsArchiveError("official-fetch", "Content-Lengthが大きすぎます");
  }
  if (length > MAX_OFFICIAL_RESPONSE_BYTES) {
    throw new NewsArchiveError("official-fetch", "公式レスポンスがサイズ上限を超えています", {
      contentLength: length,
      maxBytes: MAX_OFFICIAL_RESPONSE_BYTES,
    });
  }
  return length;
};

export type OfficialFetchResult = {
  document: StoredNewsDocument;
  byteLength: number;
};

const readResponseBody = async (
  response: Response,
): Promise<{ text: string; byteLength: number }> => {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (!response.body) {
    throw new NewsArchiveError("official-fetch", "公式レスポンス本文がありません");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_OFFICIAL_RESPONSE_BYTES) {
        await reader.cancel();
        throw new NewsArchiveError("official-fetch", "公式レスポンスがサイズ上限を超えています", {
          actualBytes: byteLength,
          maxBytes: MAX_OFFICIAL_RESPONSE_BYTES,
          contentLength,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, byteLength };
  } catch (error) {
    if (error instanceof NewsArchiveError) throw error;
    throw new NewsArchiveError("official-fetch", "公式レスポンスの読み込みに失敗しました", {
      byteLength,
    });
  } finally {
    reader.releaseLock();
  }
};

export const fetchOfficialNews = async (fetcher: NewsFetcher): Promise<OfficialFetchResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OFFICIAL_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(OFFICIAL_NEWS_URL, { signal: controller.signal });
    } catch {
      throw new NewsArchiveError(
        "official-fetch",
        controller.signal.aborted
          ? "公式ニュースの取得がタイムアウトしました"
          : "公式ニュースの取得に失敗しました",
      );
    }
    if (!response.ok) {
      throw new NewsArchiveError("official-fetch", "公式ニュースのHTTPステータスが不正です", {
        status: response.status,
      });
    }

    let text: string;
    let byteLength: number;
    try {
      ({ text, byteLength } = await readResponseBody(response));
    } catch (error) {
      if (controller.signal.aborted) {
        throw new NewsArchiveError("official-fetch", "公式ニュースの取得がタイムアウトしました");
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new NewsArchiveError("official-parse", "公式ニュースJSONの解析に失敗しました", {
        byteLength,
      });
    }
    let document: StoredNewsDocument;
    try {
      document = validateParsedOfficialNewsDocumentShape(parsed);
    } catch (error) {
      if (error instanceof NewsDataError && error.stage === "document-validation") {
        throw new NewsArchiveError("official-parse", "公式ニュースの構造が無効です", {
          byteLength,
        });
      }
      if (error instanceof NewsDataError) throw error;
      throw new NewsArchiveError("official-parse", "公式ニュースの検証に失敗しました", {
        byteLength,
      });
    }
    return { document, byteLength };
  } finally {
    clearTimeout(timeout);
  }
};

export const fetchNewsSource = fetchOfficialNews;

const getJapaneseDateParts = (timeMs: number) => {
  if (!Number.isFinite(timeMs)) {
    throw new NewsArchiveError("key-builder", "バックアップキーの日時が不正です");
  }
  const date = new Date(timeMs + 9 * 60 * 60 * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw new NewsArchiveError("key-builder", "バックアップキーの日時が不正です");
  }
  return {
    year: String(date.getUTCFullYear()).padStart(4, "0"),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0"),
  };
};

export type BackupKeys = {
  dailyKey: string;
  monthlyKey: string;
};

export const buildBackupKeys = (timeMs: number): BackupKeys => {
  const { year, month, day } = getJapaneseDateParts(timeMs);
  const utcTimestamp = new Date(timeMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "-");
  return {
    dailyKey: `daily/${year}/${month}/${day}/${utcTimestamp}.json`,
    monthlyKey: `monthly/${year}-${month}.json`,
  };
};

export const getBackupKeys = buildBackupKeys;

export type ArchiveLogger = {
  log: (event: Record<string, unknown>) => void;
  error: (event: Record<string, unknown>) => void;
};

export type NewsArchiveUpdateDependencies = {
  dataBucket: R2Bucket;
  backupBucket: R2Bucket;
  cache: KVNamespace;
  fetcher?: NewsFetcher;
  nowMs: number;
  clock?: () => number;
  logger?: ArchiveLogger;
};

export type MonthlyBackupStatus = "created" | "existing";

export type NewsArchiveUpdateResult = {
  updated: boolean;
  sourceKey: string;
  beforeCount: number;
  officialCount: number;
  addedCount: number;
  updatedCount: number;
  mergedCount: number;
  officialResponseBytes: number;
  dailyBackupKey: string | null;
  monthlyBackupKey: string;
  monthlyBackupStatus: MonthlyBackupStatus;
  readEtag: string | null;
  updatedEtag: string | null;
  processingMs: number;
};

const defaultLogger: ArchiveLogger = {
  log: (event) => console.log(event),
  error: (event) => console.error(event),
};

const asArchiveError = (
  error: unknown,
  fallbackStage: string,
  message: string,
  details: Record<string, unknown> = {},
) => {
  if (error instanceof NewsArchiveError) return error;
  if (error instanceof NewsDataError) {
    return new NewsArchiveError(error.stage || fallbackStage, error.message, {
      ...details,
      dataStage: error.stage,
      dataDetails: error.details,
    });
  }
  return new NewsArchiveError(fallbackStage, message, {
    ...details,
    originalError: serializeOriginalError(error),
  });
};

const contentType = "application/json; charset=utf-8";
const createIfAbsentCondition = () =>
  new Headers({ "If-None-Match": "*" }) as unknown as NonNullable<R2PutOptions["onlyIf"]>;

const putDailyBackup = async (bucket: R2Bucket, key: string, archiveText: string) => {
  let result: R2Object | null;
  try {
    result = await bucket.put(key, archiveText, {
      onlyIf: createIfAbsentCondition(),
      httpMetadata: { contentType },
    });
  } catch (error) {
    throw asArchiveError(error, "daily-backup", "日次バックアップの保存に失敗しました");
  }
  if (!result) {
    throw new NewsArchiveError("daily-backup", "日次バックアップキーが競合しました", {
      key,
    });
  }
};

const putCurrentArchive = async (
  bucket: R2Bucket,
  archive: ArchiveReadResult,
  mergedJson: string,
) => {
  const onlyIf = archive.currentExists
    ? { etagMatches: archive.etag as string }
    : createIfAbsentCondition();
  let result: R2Object | null;
  try {
    result = await bucket.put(CURRENT_ARCHIVE_KEY, mergedJson, {
      onlyIf,
      httpMetadata: { contentType },
    });
  } catch (error) {
    throw asArchiveError(error, "archive-write", "累積アーカイブの更新に失敗しました");
  }
  if (!result) {
    throw new NewsArchiveError("etag-conflict", "累積アーカイブの更新が競合しました", {
      readEtag: archive.etag,
    });
  }
  return result.etag;
};

const putMonthlyBackup = async (
  bucket: R2Bucket,
  key: string,
  archiveText: string,
): Promise<MonthlyBackupStatus> => {
  let result: R2Object | null;
  try {
    result = await bucket.put(key, archiveText, {
      onlyIf: createIfAbsentCondition(),
      httpMetadata: { contentType },
    });
  } catch (error) {
    throw asArchiveError(error, "monthly-backup", "月次バックアップの保存に失敗しました", {
      key,
    });
  }
  return result ? "created" : "existing";
};

export const updateNewsArchive = async (
  dependencies: NewsArchiveUpdateDependencies,
): Promise<NewsArchiveUpdateResult> => {
  const startedAt = dependencies.clock?.() ?? Date.now();
  const logger = dependencies.logger ?? defaultLogger;
  let archive: ArchiveReadResult | undefined;
  let officialResponseBytes = 0;
  try {
    const [archiveResult, officialResult] = await Promise.allSettled([
      readArchive(dependencies.dataBucket),
      fetchOfficialNews(dependencies.fetcher ?? fetch),
    ]);
    if (archiveResult.status === "rejected") throw archiveResult.reason;
    archive = archiveResult.value;
    if (officialResult.status === "rejected") throw officialResult.reason;
    const official = officialResult.value;
    officialResponseBytes = official.byteLength;
    const merged = mergeValidatedNewsDocument(archive.document, official.document, {
      officialOrigin: OFFICIAL_NEWS_ORIGIN,
      validateOfficialEntries: true,
    });
    const updated =
      !archive.currentExists || merged.stats.addedCount > 0 || merged.stats.updatedCount > 0;
    const backupKeys = buildBackupKeys(dependencies.nowMs);
    let dailyBackupKey: string | null = null;
    let updatedEtag: string | null = archive.currentExists ? archive.etag : null;
    let mergedJson: string | null = null;

    if (updated) {
      mergedJson = serializeSortedNewsDocument(merged.document).json;
      dailyBackupKey = backupKeys.dailyKey;
      await putDailyBackup(dependencies.backupBucket, dailyBackupKey, archive.text);
      updatedEtag = await putCurrentArchive(dependencies.dataBucket, archive, mergedJson);
      try {
        await dependencies.cache.delete("kf3-news");
      } catch (error) {
        throw asArchiveError(error, "cache-delete", "ニュースキャッシュの削除に失敗しました");
      }
    }

    const monthlyBackupStatus = await putMonthlyBackup(
      dependencies.backupBucket,
      backupKeys.monthlyKey,
      mergedJson ?? archive.text,
    );
    const processingMs = Math.max(0, (dependencies.clock?.() ?? Date.now()) - startedAt);
    const result: NewsArchiveUpdateResult = {
      updated,
      sourceKey: archive.sourceKey,
      beforeCount: merged.stats.beforeCount,
      officialCount: merged.stats.officialCount,
      addedCount: merged.stats.addedCount,
      updatedCount: merged.stats.updatedCount,
      mergedCount: merged.stats.mergedCount,
      officialResponseBytes,
      dailyBackupKey,
      monthlyBackupKey: backupKeys.monthlyKey,
      monthlyBackupStatus,
      readEtag: archive.etag,
      updatedEtag,
      processingMs,
    };
    logger.log({
      event: "news_archive_update",
      executedAtUtc: new Date(dependencies.nowMs).toISOString(),
      updateStatus: updated ? "updated" : "unchanged",
      ...result,
    });
    return result;
  } catch (error) {
    const archiveError = asArchiveError(
      error,
      "archive-validation",
      "ニュースアーカイブの更新に失敗しました",
    );
    logger.error({
      event: "news_archive_update_failed",
      stage: archiveError.stage,
      error: archiveError.message,
      details: archiveError.details,
      beforeCount: archive?.document.news.length ?? null,
    });
    throw archiveError;
  }
};

export const runNewsArchiveUpdate = updateNewsArchive;
