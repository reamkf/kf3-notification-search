import * as v from "valibot";
import { type JsonInput, type JsonValue } from "./schema";

export const NEWS_SOURCE_HEADER = "X-KF3-News-Source";
export const NEWS_OFFICIAL_CHECKED_AT_HEADER = "X-KF3-News-Official-Checked-At";
export const NEWS_FETCHED_AT_HEADER = "X-KF3-News-Fetched-At";
export const NEWS_REFRESH_AVAILABLE_AT_HEADER = "X-KF3-News-Refresh-Available-At";
export const NEWS_DATA_VERSION_HEADER = "X-KF3-News-Data-Version";
export const NEWS_CACHE_METADATA_VERSION = 2;

export type NewsCacheSource = "merged" | "archive-fallback" | "archive-snapshot";
export type NewsResponseSource = NewsCacheSource | "unknown";

export type NewsCacheMetadataV1 = {
  version: 1;
  source: NewsCacheSource;
  fetchedAt: string;
};

type LegacyNewsCacheMetadataV2 = {
  version: typeof NEWS_CACHE_METADATA_VERSION;
  source: NewsCacheSource;
  fetchedAt: string;
  baseArchiveEtag: string | null;
  newsCount: number;
  refreshAvailableAt?: string | null;
};

export type NewsCacheMetadataV2 = {
  version: typeof NEWS_CACHE_METADATA_VERSION;
  source: NewsCacheSource;
  officialCheckedAt: string | null;
  baseArchiveEtag: string | null;
  newsCount: number;
  refreshAvailableAt?: string | null;
};

export type NewsCacheMetadata =
  | NewsCacheMetadataV1
  | LegacyNewsCacheMetadataV2
  | NewsCacheMetadataV2;

export type NewsResponseMetadata = {
  source: NewsResponseSource;
  officialCheckedAt: string | null;
  refreshAvailableAt: string | null;
  dataVersion: string | null;
};

export type NewsRefreshState = {
  version: 1;
  baseArchiveEtag: string | null;
  officialCheckedAt: string;
  refreshAvailableAt: string;
};

const isValidTimestamp = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

const isLegacyTimestamp = (value: string) => Number.isFinite(Date.parse(value));
const canonicalTimestampSchema = v.pipe(v.string(), v.check(isValidTimestamp));
const legacyTimestampSchema = v.pipe(v.string(), v.check(isLegacyTimestamp));
const sourceSchema = v.union([
  v.literal("merged"),
  v.literal("archive-fallback"),
  v.literal("archive-snapshot"),
]);
const archiveEtagSchema = v.nullable(v.pipe(v.string(), v.minLength(1)));
const newsCountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const newsCacheMetadataV1Schema = v.object({
  version: v.literal(1),
  source: sourceSchema,
  fetchedAt: legacyTimestampSchema,
});

const legacyNewsCacheMetadataV2Schema = v.object({
  version: v.literal(NEWS_CACHE_METADATA_VERSION),
  source: sourceSchema,
  fetchedAt: legacyTimestampSchema,
  baseArchiveEtag: archiveEtagSchema,
  newsCount: newsCountSchema,
});

const newsCacheMetadataV2Schema = v.object({
  version: v.literal(NEWS_CACHE_METADATA_VERSION),
  source: sourceSchema,
  officialCheckedAt: v.nullable(canonicalTimestampSchema),
  baseArchiveEtag: archiveEtagSchema,
  newsCount: newsCountSchema,
  refreshAvailableAt: v.optional(v.nullable(canonicalTimestampSchema)),
});

const refreshAvailableAtSchema = v.object({
  refreshAvailableAt: v.optional(v.nullable(canonicalTimestampSchema)),
});

const newsRefreshStateSchema = v.object({
  version: v.literal(1),
  baseArchiveEtag: archiveEtagSchema,
  officialCheckedAt: canonicalTimestampSchema,
  refreshAvailableAt: canonicalTimestampSchema,
});

const isCurrentNewsCacheMetadata = (value: NewsCacheMetadata): value is NewsCacheMetadataV2 =>
  value.version === NEWS_CACHE_METADATA_VERSION && "officialCheckedAt" in value;

export const createNewsCacheMetadata = (
  source: NewsCacheSource,
  officialCheckedAt: string | null,
  baseArchiveEtag: string | null = null,
  newsCount = 0,
): NewsCacheMetadataV2 => ({
  version: NEWS_CACHE_METADATA_VERSION,
  source,
  officialCheckedAt,
  baseArchiveEtag,
  newsCount,
});

export const parseNewsCacheMetadata = (value: JsonInput): NewsCacheMetadata | null => {
  const current = v.safeParse(newsCacheMetadataV2Schema, value);
  if (current.success) return current.output;

  const legacy = v.safeParse(legacyNewsCacheMetadataV2Schema, value);
  if (legacy.success) return legacy.output;

  const versionOne = v.safeParse(newsCacheMetadataV1Schema, value);
  return versionOne.success ? versionOne.output : null;
};

export const isReusableNewsCacheMetadata = (value: JsonInput): value is NewsCacheMetadataV2 => {
  const metadata = parseNewsCacheMetadata(value);
  return metadata !== null && isCurrentNewsCacheMetadata(metadata);
};

export const createNewsRefreshState = (
  baseArchiveEtag: string | null,
  officialCheckedAt: string,
  refreshAvailableAt: string,
): NewsRefreshState => ({
  version: 1,
  baseArchiveEtag,
  officialCheckedAt,
  refreshAvailableAt,
});

const getRefreshAvailableAt = (value: JsonInput): string | null => {
  const result = v.safeParse(refreshAvailableAtSchema, value);
  return result.success ? (result.output.refreshAvailableAt ?? null) : null;
};

export const parseNewsRefreshState = (value: string | null): NewsRefreshState | null => {
  if (value === null) return null;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = v.safeParse(newsRefreshStateSchema, parsed);
  return result.success ? result.output : null;
};

export const applyNewsRefreshState = (
  metadata: JsonInput,
  state: NewsRefreshState | null,
): NewsCacheMetadata | undefined => {
  const parsedMetadata = parseNewsCacheMetadata(metadata);
  if (!parsedMetadata) return undefined;
  const refreshAvailableAt = getRefreshAvailableAt(metadata);
  const metadataWithRefreshAvailableAt =
    refreshAvailableAt === null ? parsedMetadata : { ...parsedMetadata, refreshAvailableAt };
  if (!state || !isCurrentNewsCacheMetadata(parsedMetadata)) {
    return metadataWithRefreshAvailableAt;
  }
  if (parsedMetadata.baseArchiveEtag !== state.baseArchiveEtag)
    return metadataWithRefreshAvailableAt;
  return {
    ...parsedMetadata,
    officialCheckedAt: state.officialCheckedAt,
    refreshAvailableAt: state.refreshAvailableAt,
  };
};

export const toNewsResponseMetadata = (value: JsonInput): NewsResponseMetadata => {
  const metadata = parseNewsCacheMetadata(value);
  if (!metadata) {
    return {
      source: "unknown",
      officialCheckedAt: null,
      refreshAvailableAt: null,
      dataVersion: null,
    };
  }
  return {
    source: metadata.source,
    officialCheckedAt: isCurrentNewsCacheMetadata(metadata) ? metadata.officialCheckedAt : null,
    refreshAvailableAt: getRefreshAvailableAt(value),
    dataVersion:
      isCurrentNewsCacheMetadata(metadata) && metadata.source !== "archive-fallback"
        ? metadata.baseArchiveEtag
        : null,
  };
};

export const createNewsResponseHeaders = (metadata: JsonInput): Headers => {
  const responseMetadata = toNewsResponseMetadata(metadata);
  const headers = new Headers({
    "content-type": "application/json; charset=UTF-8",
    [NEWS_SOURCE_HEADER]: responseMetadata.source,
  });
  if (responseMetadata.officialCheckedAt) {
    headers.set(NEWS_OFFICIAL_CHECKED_AT_HEADER, responseMetadata.officialCheckedAt);
    headers.set(NEWS_FETCHED_AT_HEADER, responseMetadata.officialCheckedAt);
  }
  if (responseMetadata.refreshAvailableAt) {
    headers.set(NEWS_REFRESH_AVAILABLE_AT_HEADER, responseMetadata.refreshAvailableAt);
  }
  if (responseMetadata.dataVersion) {
    headers.set(NEWS_DATA_VERSION_HEADER, responseMetadata.dataVersion);
  }
  return headers;
};

export const parseNewsResponseHeaders = (headers: Headers): NewsResponseMetadata => {
  const source = headers.get(NEWS_SOURCE_HEADER);
  const hasOfficialCheckedAtHeader = headers.has(NEWS_OFFICIAL_CHECKED_AT_HEADER);
  const officialCheckedAt =
    headers.get(NEWS_OFFICIAL_CHECKED_AT_HEADER) ?? headers.get(NEWS_FETCHED_AT_HEADER);
  const refreshAvailableAt = headers.get(NEWS_REFRESH_AVAILABLE_AT_HEADER);
  const normalizedSource: NewsResponseSource =
    source === "merged" || source === "archive-fallback" || source === "archive-snapshot"
      ? source
      : "unknown";
  return {
    source: normalizedSource,
    officialCheckedAt:
      normalizedSource === "unknown" || officialCheckedAt === null
        ? null
        : hasOfficialCheckedAtHeader
          ? v.safeParse(canonicalTimestampSchema, officialCheckedAt).success
            ? officialCheckedAt
            : null
          : v.safeParse(legacyTimestampSchema, officialCheckedAt).success
            ? officialCheckedAt
            : null,
    refreshAvailableAt:
      normalizedSource === "unknown" || refreshAvailableAt === null
        ? null
        : v.safeParse(canonicalTimestampSchema, refreshAvailableAt).success
          ? refreshAvailableAt
          : null,
    dataVersion:
      normalizedSource === "unknown" ? null : headers.get(NEWS_DATA_VERSION_HEADER) || null,
  };
};
