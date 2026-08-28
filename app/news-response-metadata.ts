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
};

export type NewsCacheMetadataV2 = {
  version: typeof NEWS_CACHE_METADATA_VERSION;
  source: NewsCacheSource;
  officialCheckedAt: string | null;
  baseArchiveEtag: string | null;
  newsCount: number;
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

const isValidTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

const isLegacyTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const isOptionalTimestamp = (value: unknown): value is string | null =>
  value === null || isValidTimestamp(value);

const isNewsCacheSource = (value: unknown): value is NewsCacheSource =>
  value === "merged" || value === "archive-fallback" || value === "archive-snapshot";

const isValidArchiveEtag = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length > 0);

const isValidNewsCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

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

export const parseNewsCacheMetadata = (value: unknown): NewsCacheMetadata | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!isNewsCacheSource(candidate.source)) return null;

  if (candidate.version === 1) {
    if (!isLegacyTimestamp(candidate.fetchedAt)) return null;
    return {
      version: 1,
      source: candidate.source,
      fetchedAt: candidate.fetchedAt,
    };
  }

  if (candidate.version !== NEWS_CACHE_METADATA_VERSION) return null;
  if (!Object.hasOwn(candidate, "officialCheckedAt")) {
    if (
      !isLegacyTimestamp(candidate.fetchedAt) ||
      !isValidArchiveEtag(candidate.baseArchiveEtag) ||
      !isValidNewsCount(candidate.newsCount)
    ) {
      return null;
    }
    return {
      version: NEWS_CACHE_METADATA_VERSION,
      source: candidate.source,
      fetchedAt: candidate.fetchedAt,
      baseArchiveEtag: candidate.baseArchiveEtag,
      newsCount: candidate.newsCount,
    };
  }

  if (
    !isOptionalTimestamp(candidate.officialCheckedAt) ||
    !isValidArchiveEtag(candidate.baseArchiveEtag) ||
    !isValidNewsCount(candidate.newsCount)
  ) {
    return null;
  }
  return {
    version: NEWS_CACHE_METADATA_VERSION,
    source: candidate.source,
    officialCheckedAt: candidate.officialCheckedAt,
    baseArchiveEtag: candidate.baseArchiveEtag,
    newsCount: candidate.newsCount,
  };
};

const isCurrentNewsCacheMetadata = (value: NewsCacheMetadata): value is NewsCacheMetadataV2 =>
  value.version === NEWS_CACHE_METADATA_VERSION && Object.hasOwn(value, "officialCheckedAt");

export const isReusableNewsCacheMetadata = (value: unknown): value is NewsCacheMetadataV2 => {
  const metadata = parseNewsCacheMetadata(value);
  return metadata !== null && isCurrentNewsCacheMetadata(metadata);
};

const getRefreshAvailableAt = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const refreshAvailableAt = (value as Record<string, unknown>).refreshAvailableAt;
  return isValidTimestamp(refreshAvailableAt) ? refreshAvailableAt : null;
};

export const toNewsResponseMetadata = (value: unknown): NewsResponseMetadata => {
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

export const createNewsResponseHeaders = (metadata: unknown): Headers => {
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
      normalizedSource === "unknown" ||
      !(hasOfficialCheckedAtHeader
        ? isValidTimestamp(officialCheckedAt)
        : isLegacyTimestamp(officialCheckedAt))
        ? null
        : officialCheckedAt,
    refreshAvailableAt:
      normalizedSource === "unknown" || !isValidTimestamp(refreshAvailableAt)
        ? null
        : refreshAvailableAt,
    dataVersion:
      normalizedSource === "unknown" ? null : headers.get(NEWS_DATA_VERSION_HEADER) || null,
  };
};
