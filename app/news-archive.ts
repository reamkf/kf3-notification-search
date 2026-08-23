import type {
  KVNamespace,
  R2Bucket,
  R2Object,
  R2ObjectBody,
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
import { NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY, NEWS_CACHE_KEY } from "./news-cache-keys";

export const OFFICIAL_NEWS_URL = `${OFFICIAL_NEWS_ORIGIN}/info/all/entries.txt`;
export const OFFICIAL_FETCH_TIMEOUT_MS = 10_000;
export const CURRENT_ARCHIVE_KEY = "archive/current.json";
export const OFFICIAL_FETCH_STATE_KEY = "archive/official-fetch-state.json";
export const LEGACY_ARCHIVE_KEY = "entries_merged_20241107.json";
export { MAX_OFFICIAL_RESPONSE_BYTES } from "./news-data";

const OFFICIAL_FETCH_STATE_VERSION = 1;
const MAX_OFFICIAL_ETAG_LENGTH = 1024;

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

export type OfficialFetchState = {
  version: 1;
  officialEtag: string;
  currentEtag: string;
};

type OfficialFetchStateRead = {
  state: OfficialFetchState | null;
  objectEtag: string | null;
  status: "valid" | "missing" | "invalid" | "unavailable";
};

export type OfficialFetchEligibility = {
  state: OfficialFetchState | null;
  stateObjectEtag: string | null;
  stateStatus: OfficialFetchStateRead["status"];
  currentEtag: string | null;
  currentExists: boolean;
  currentEtagMatchedState: boolean;
  ifNoneMatch: string | null;
};

const isStrongOfficialEtag = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > MAX_OFFICIAL_ETAG_LENGTH ||
    !value.startsWith('"') ||
    !value.endsWith('"') ||
    value.startsWith("W/")
  ) {
    return false;
  }

  for (const character of value.slice(1, -1)) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint !== 0x21 &&
        (codePoint < 0x23 || codePoint > 0x7e) &&
        (codePoint < 0x80 || codePoint > 0xff))
    ) {
      return false;
    }
  }
  return true;
};

const isValidCurrentEtag = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

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

export const serializeArchiveErrorForLog = (error: unknown) => {
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
    originalError: serializeArchiveErrorForLog(error),
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

const readOfficialFetchState = async (bucket: R2Bucket): Promise<OfficialFetchStateRead> => {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(OFFICIAL_FETCH_STATE_KEY);
  } catch {
    return { state: null, objectEtag: null, status: "unavailable" };
  }
  if (!object) return { state: null, objectEtag: null, status: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await object.text());
  } catch {
    return { state: null, objectEtag: object.etag, status: "invalid" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== OFFICIAL_FETCH_STATE_VERSION ||
    !isStrongOfficialEtag((parsed as { officialEtag?: unknown }).officialEtag) ||
    !isValidCurrentEtag((parsed as { currentEtag?: unknown }).currentEtag)
  ) {
    return { state: null, objectEtag: object.etag, status: "invalid" };
  }
  return {
    state: parsed as OfficialFetchState,
    objectEtag: object.etag,
    status: "valid",
  };
};

export const readOfficialFetchEligibility = async (
  bucket: R2Bucket,
): Promise<OfficialFetchEligibility> => {
  const [stateResult, currentResult] = await Promise.allSettled([
    readOfficialFetchState(bucket),
    bucket.head(CURRENT_ARCHIVE_KEY),
  ]);
  const stateRead =
    stateResult.status === "fulfilled"
      ? stateResult.value
      : { state: null, objectEtag: null, status: "unavailable" as const };
  const currentObject = currentResult.status === "fulfilled" ? currentResult.value : null;
  const currentEtag = currentObject?.etag ?? null;
  const currentEtagMatchedState =
    stateRead.state !== null &&
    currentObject !== null &&
    stateRead.state.currentEtag === currentEtag;
  return {
    state: stateRead.state,
    stateObjectEtag: stateRead.objectEtag,
    stateStatus: stateRead.status,
    currentEtag,
    currentExists: currentObject !== null,
    currentEtagMatchedState,
    ifNoneMatch: currentEtagMatchedState ? (stateRead.state?.officialEtag ?? null) : null,
  };
};

const isR2ObjectBody = (object: R2Object | R2ObjectBody | null): object is R2ObjectBody =>
  object !== null && "body" in object && typeof object.text === "function";

export const readCurrentArchiveDocumentIfEtag = async (
  bucket: R2Bucket,
  etag: string,
): Promise<ArchiveDocumentReadResult | null> => {
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await bucket.get(CURRENT_ARCHIVE_KEY, { onlyIf: { etagMatches: etag } });
  } catch (error) {
    throw createArchiveReadError(error, { sourceKey: CURRENT_ARCHIVE_KEY });
  }
  if (!isR2ObjectBody(object) || object.etag !== etag) return null;
  const text = await readObjectText(object, CURRENT_ARCHIVE_KEY);
  return {
    document: parseArchiveText(text, CURRENT_ARCHIVE_KEY),
    sourceKey: CURRENT_ARCHIVE_KEY,
    etag: object.etag,
    currentExists: true,
  };
};

export const readCurrentArchiveBodyIfEtag = async (
  bucket: R2Bucket,
  etag: string,
): Promise<R2ObjectBody | null> => {
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await bucket.get(CURRENT_ARCHIVE_KEY, { onlyIf: { etagMatches: etag } });
  } catch (error) {
    throw createArchiveReadError(error, { sourceKey: CURRENT_ARCHIVE_KEY });
  }
  return isR2ObjectBody(object) && object.etag === etag ? object : null;
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

export type OfficialFetchResult =
  | {
      status: "modified";
      document: StoredNewsDocument;
      byteLength: number;
      officialEtag: string | null;
      conditionalRequestUsed: boolean;
    }
  | {
      status: "not-modified";
      byteLength: 0;
      officialEtag: string;
      conditionalRequestUsed: true;
    };

export type OfficialFetchOptions = {
  ifNoneMatch?: string;
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

export const fetchOfficialNews = async (
  fetcher: NewsFetcher,
  options: OfficialFetchOptions = {},
): Promise<OfficialFetchResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OFFICIAL_FETCH_TIMEOUT_MS);
  const conditionalEtag = isStrongOfficialEtag(options.ifNoneMatch) ? options.ifNoneMatch : null;
  const conditionalRequestUsed = conditionalEtag !== null;
  try {
    let response: Response;
    try {
      const headers = conditionalEtag
        ? new Headers({ "If-None-Match": conditionalEtag })
        : undefined;
      response = await fetcher(OFFICIAL_NEWS_URL, {
        signal: controller.signal,
        ...(headers ? { headers } : {}),
      });
    } catch {
      throw new NewsArchiveError(
        "official-fetch",
        controller.signal.aborted
          ? "公式お知らせの取得がタイムアウトしました"
          : "公式お知らせの取得に失敗しました",
      );
    }

    if (response.status === 304) {
      if (!conditionalRequestUsed) {
        throw new NewsArchiveError("official-fetch", "条件なしリクエストが304を返しました");
      }
      const responseEtag = response.headers.get("etag");
      if (responseEtag !== null && responseEtag !== conditionalEtag) {
        throw new NewsArchiveError("official-fetch", "304レスポンスのETagが一致しません");
      }
      const officialEtag = responseEtag ?? conditionalEtag;
      if (!isStrongOfficialEtag(officialEtag)) {
        throw new NewsArchiveError("official-fetch", "304レスポンスのETagが不正です");
      }
      return {
        status: "not-modified",
        byteLength: 0,
        officialEtag,
        conditionalRequestUsed: true,
      };
    }
    if (response.status !== 200) {
      throw new NewsArchiveError("official-fetch", "公式お知らせのHTTPステータスが不正です", {
        status: response.status,
      });
    }

    let text: string;
    let byteLength: number;
    try {
      ({ text, byteLength } = await readResponseBody(response));
    } catch (error) {
      if (controller.signal.aborted) {
        throw new NewsArchiveError("official-fetch", "公式お知らせの取得がタイムアウトしました");
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new NewsArchiveError("official-parse", "公式お知らせJSONの解析に失敗しました", {
        byteLength,
      });
    }
    let document: StoredNewsDocument;
    try {
      document = validateParsedOfficialNewsDocumentShape(parsed);
    } catch (error) {
      if (error instanceof NewsDataError && error.stage === "document-validation") {
        throw new NewsArchiveError("official-parse", "公式お知らせの構造が無効です", {
          byteLength,
        });
      }
      if (error instanceof NewsDataError) throw error;
      throw new NewsArchiveError("official-parse", "公式お知らせの検証に失敗しました", {
        byteLength,
      });
    }
    return {
      status: "modified",
      document,
      byteLength,
      officialEtag: response.headers.get("etag"),
      conditionalRequestUsed,
    };
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

export type NewsArchiveUpdateTrigger = "scheduled" | "queue" | "manual";

export type NewsArchiveUpdateDependencies = {
  dataBucket: R2Bucket;
  backupBucket: R2Bucket;
  cache: KVNamespace;
  fetcher?: NewsFetcher;
  nowMs: number;
  clock?: () => number;
  logger?: ArchiveLogger;
  trigger?: NewsArchiveUpdateTrigger;
  invalidateDisplayCache?: boolean;
};

export type MonthlyBackupStatus = "created" | "existing" | "not-checked";
export type EtagStateStatus = "saved" | "unchanged" | "unavailable" | "conflicted";

export type NewsArchiveUpdateResult = {
  updated: boolean;
  sourceKey: string;
  beforeCount: number | null;
  officialCount: number | null;
  addedCount: number | null;
  updatedCount: number | null;
  mergedCount: number | null;
  officialResponseBytes: number;
  dailyBackupKey: string | null;
  monthlyBackupKey: string;
  monthlyBackupStatus: MonthlyBackupStatus;
  officialFetchStatus: "modified" | "not-modified";
  conditionalRequestUsed: boolean;
  currentEtagMatchedState: boolean;
  officialBodyProcessed: boolean;
  etagStateStatus: EtagStateStatus;
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
    originalError: serializeArchiveErrorForLog(error),
  });
};

const contentType = "application/json; charset=utf-8";
const createIfAbsentCondition = () => ({ etagDoesNotMatch: "*" });
const isObjectLockedByBucketPolicy = (error: unknown) =>
  error instanceof Error && /\(10069\)\s*$/.test(error.message);

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
    throw new NewsArchiveError("etag-conflict", "累積アーカイブの更新が競合しました");
  }
  return result.etag;
};

const hasMonthlyBackup = async (bucket: R2Bucket, key: string): Promise<boolean> => {
  try {
    return (await bucket.head(key)) !== null;
  } catch (error) {
    throw asArchiveError(error, "monthly-backup", "月次バックアップの確認に失敗しました", {
      key,
    });
  }
};

const putMonthlyBackup = async (
  bucket: R2Bucket,
  key: string,
  archiveValue: string | R2ObjectBody["body"],
  options: { monthlyMissingChecked?: boolean } = {},
): Promise<MonthlyBackupStatus> => {
  if (!options.monthlyMissingChecked && (await hasMonthlyBackup(bucket, key))) {
    return "existing";
  }

  let result: R2Object | null;
  try {
    result = await bucket.put(key, archiveValue, {
      onlyIf: createIfAbsentCondition(),
      httpMetadata: { contentType },
    });
  } catch (error) {
    if (isObjectLockedByBucketPolicy(error)) return "existing";
    throw asArchiveError(error, "monthly-backup", "月次バックアップの保存に失敗しました", {
      key,
    });
  }
  return result ? "created" : "existing";
};

const saveOfficialFetchState = async (
  bucket: R2Bucket,
  officialEtag: string | null,
  currentEtag: string | null,
  previous: OfficialFetchStateRead,
): Promise<EtagStateStatus> => {
  if (!isStrongOfficialEtag(officialEtag) || !isValidCurrentEtag(currentEtag)) return "unavailable";
  if (previous.state?.officialEtag === officialEtag && previous.state.currentEtag === currentEtag) {
    return "unchanged";
  }
  if (previous.status === "unavailable" && previous.objectEtag === null) return "unavailable";

  const state: OfficialFetchState = {
    version: OFFICIAL_FETCH_STATE_VERSION,
    officialEtag,
    currentEtag,
  };
  const onlyIf = previous.objectEtag
    ? { etagMatches: previous.objectEtag }
    : { etagDoesNotMatch: "*" as const };
  try {
    const result = await bucket.put(OFFICIAL_FETCH_STATE_KEY, JSON.stringify(state), {
      onlyIf,
      httpMetadata: { contentType },
    });
    return result ? "saved" : "conflicted";
  } catch {
    return "unavailable";
  }
};

export const updateNewsArchive = async (
  dependencies: NewsArchiveUpdateDependencies,
): Promise<NewsArchiveUpdateResult> => {
  const startedAt = dependencies.clock?.() ?? Date.now();
  const logger = dependencies.logger ?? defaultLogger;
  const fetcher = dependencies.fetcher ?? fetch;
  const backupKeys = buildBackupKeys(dependencies.nowMs);
  let archive: ArchiveReadResult | undefined;
  const eligibility = await readOfficialFetchEligibility(dependencies.dataBucket);
  const previousState: OfficialFetchStateRead = {
    state: eligibility.state,
    objectEtag: eligibility.stateObjectEtag,
    status: eligibility.stateStatus,
  };

  const logResult = (result: NewsArchiveUpdateResult) => {
    logger.log({
      event: "news_archive_update",
      trigger: dependencies.trigger ?? "manual",
      executedAtUtc: new Date(dependencies.nowMs).toISOString(),
      updateStatus: result.updated ? "updated" : "unchanged",
      updated: result.updated,
      sourceKey: result.sourceKey,
      beforeCount: result.beforeCount,
      officialCount: result.officialCount,
      addedCount: result.addedCount,
      updatedCount: result.updatedCount,
      mergedCount: result.mergedCount,
      officialResponseBytes: result.officialResponseBytes,
      dailyBackupKey: result.dailyBackupKey,
      monthlyBackupKey: result.monthlyBackupKey,
      monthlyBackupStatus: result.monthlyBackupStatus,
      officialFetchStatus: result.officialFetchStatus,
      conditionalRequestUsed: result.conditionalRequestUsed,
      currentEtagMatchedState: result.currentEtagMatchedState,
      officialBodyProcessed: result.officialBodyProcessed,
      etagStateStatus: result.etagStateStatus,
      processingMs: result.processingMs,
    });
  };

  const completeNotModified = async (
    official: Extract<OfficialFetchResult, { status: "not-modified" }>,
  ): Promise<NewsArchiveUpdateResult | null> => {
    if (!eligibility.state || !eligibility.currentEtagMatchedState) return null;
    const monthlyExists = await hasMonthlyBackup(dependencies.backupBucket, backupKeys.monthlyKey);
    if (monthlyExists) {
      const processingMs = Math.max(0, (dependencies.clock?.() ?? Date.now()) - startedAt);
      const result: NewsArchiveUpdateResult = {
        updated: false,
        sourceKey: CURRENT_ARCHIVE_KEY,
        beforeCount: null,
        officialCount: null,
        addedCount: null,
        updatedCount: null,
        mergedCount: null,
        officialResponseBytes: official.byteLength,
        dailyBackupKey: null,
        monthlyBackupKey: backupKeys.monthlyKey,
        monthlyBackupStatus: "existing",
        officialFetchStatus: "not-modified",
        conditionalRequestUsed: true,
        currentEtagMatchedState: true,
        officialBodyProcessed: false,
        etagStateStatus: "unchanged",
        readEtag: eligibility.currentEtag,
        updatedEtag: eligibility.currentEtag,
        processingMs,
      };
      logResult(result);
      return result;
    }

    const currentObject = await readCurrentArchiveBodyIfEtag(
      dependencies.dataBucket,
      eligibility.state.currentEtag,
    );
    if (!currentObject) return null;
    const monthlyBackupStatus = await putMonthlyBackup(
      dependencies.backupBucket,
      backupKeys.monthlyKey,
      currentObject.body,
      { monthlyMissingChecked: true },
    );
    const processingMs = Math.max(0, (dependencies.clock?.() ?? Date.now()) - startedAt);
    const result: NewsArchiveUpdateResult = {
      updated: false,
      sourceKey: CURRENT_ARCHIVE_KEY,
      beforeCount: null,
      officialCount: null,
      addedCount: null,
      updatedCount: null,
      mergedCount: null,
      officialResponseBytes: official.byteLength,
      dailyBackupKey: null,
      monthlyBackupKey: backupKeys.monthlyKey,
      monthlyBackupStatus,
      officialFetchStatus: "not-modified",
      conditionalRequestUsed: true,
      currentEtagMatchedState: true,
      officialBodyProcessed: false,
      etagStateStatus: "unchanged",
      readEtag: eligibility.currentEtag,
      updatedEtag: eligibility.currentEtag,
      processingMs,
    };
    logResult(result);
    return result;
  };

  const completeModified = async (
    official: Extract<OfficialFetchResult, { status: "modified" }>,
    archiveOverride?: ArchiveReadResult,
  ): Promise<NewsArchiveUpdateResult> => {
    archive = archiveOverride ?? (await readArchive(dependencies.dataBucket));
    const merged = mergeValidatedNewsDocument(archive.document, official.document, {
      officialOrigin: OFFICIAL_NEWS_ORIGIN,
      validateOfficialEntries: true,
    });
    const updated =
      !archive.currentExists || merged.stats.addedCount > 0 || merged.stats.updatedCount > 0;
    let dailyBackupKey: string | null = null;
    let updatedEtag: string | null = archive.currentExists ? archive.etag : null;
    let mergedJson: string | null = null;

    if (updated) {
      mergedJson = serializeSortedNewsDocument(merged.document).json;
      dailyBackupKey = backupKeys.dailyKey;
      await putDailyBackup(dependencies.backupBucket, dailyBackupKey, archive.text);
      updatedEtag = await putCurrentArchive(dependencies.dataBucket, archive, mergedJson);
      try {
        await dependencies.cache.delete(NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY);
        if (dependencies.invalidateDisplayCache !== false) {
          await dependencies.cache.delete(NEWS_CACHE_KEY);
        }
      } catch (error) {
        throw asArchiveError(error, "cache-delete", "お知らせキャッシュの削除に失敗しました");
      }
    }

    const monthlyBackupStatus = await putMonthlyBackup(
      dependencies.backupBucket,
      backupKeys.monthlyKey,
      mergedJson ?? archive.text,
    );
    const etagStateStatus = await saveOfficialFetchState(
      dependencies.dataBucket,
      official.officialEtag,
      updatedEtag,
      previousState,
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
      officialResponseBytes: official.byteLength,
      dailyBackupKey,
      monthlyBackupKey: backupKeys.monthlyKey,
      monthlyBackupStatus,
      officialFetchStatus: "modified",
      conditionalRequestUsed: official.conditionalRequestUsed,
      currentEtagMatchedState: eligibility.currentEtagMatchedState,
      officialBodyProcessed: true,
      etagStateStatus,
      readEtag: archive.etag,
      updatedEtag,
      processingMs,
    };
    logResult(result);
    return result;
  };

  try {
    let official: OfficialFetchResult;
    if (eligibility.ifNoneMatch) {
      official = await fetchOfficialNews(fetcher, { ifNoneMatch: eligibility.ifNoneMatch });
      if (official.status === "not-modified") {
        const result = await completeNotModified(official);
        if (result) return result;
        const fullResults = await Promise.allSettled([
          readArchive(dependencies.dataBucket),
          fetchOfficialNews(fetcher),
        ]);
        if (fullResults[0].status === "rejected") throw fullResults[0].reason;
        if (fullResults[1].status === "rejected") throw fullResults[1].reason;
        if (fullResults[1].value.status !== "modified") {
          throw new NewsArchiveError("official-fetch", "公式お知らせの応答形式が不正です");
        }
        return await completeModified(fullResults[1].value, fullResults[0].value);
      }
      return await completeModified(official);
    }

    const [archiveResult, officialResult] = await Promise.allSettled([
      readArchive(dependencies.dataBucket),
      fetchOfficialNews(fetcher),
    ]);
    if (archiveResult.status === "rejected") throw archiveResult.reason;
    if (officialResult.status === "rejected") throw officialResult.reason;
    if (officialResult.value.status !== "modified") {
      throw new NewsArchiveError("official-fetch", "公式お知らせの応答形式が不正です");
    }
    return await completeModified(officialResult.value, archiveResult.value);
  } catch (error) {
    const archiveError = asArchiveError(
      error,
      "archive-validation",
      "お知らせアーカイブの更新に失敗しました",
    );
    logger.error({
      event: "news_archive_update_failed",
      trigger: dependencies.trigger ?? "manual",
      stage: archiveError.stage,
      error: archiveError.message,
      details: archiveError.details,
      beforeCount: archive?.document.news.length ?? null,
    });
    throw archiveError;
  }
};

export const runNewsArchiveUpdate = updateNewsArchive;
