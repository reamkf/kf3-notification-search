export const NEWS_SOURCE_HEADER = "X-KF3-News-Source";
export const NEWS_FETCHED_AT_HEADER = "X-KF3-News-Fetched-At";
export const NEWS_CACHE_METADATA_VERSION = 2;

export type NewsCacheSource = "merged" | "archive-fallback" | "archive-snapshot";
export type NewsResponseSource = NewsCacheSource | "unknown";

export type NewsCacheMetadataV1 = {
  version: 1;
  source: NewsCacheSource;
  fetchedAt: string;
};

export type NewsCacheMetadataV2 = {
  version: typeof NEWS_CACHE_METADATA_VERSION;
  source: NewsCacheSource;
  fetchedAt: string;
  baseArchiveEtag: string | null;
  newsCount: number;
};

export type NewsCacheMetadata = NewsCacheMetadataV1 | NewsCacheMetadataV2;

export type NewsResponseMetadata = {
  source: NewsResponseSource;
  fetchedAt: string | null;
};

const isValidTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const isNewsCacheSource = (value: unknown): value is NewsCacheSource =>
  value === "merged" || value === "archive-fallback" || value === "archive-snapshot";

const isValidArchiveEtag = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length > 0);

const isValidNewsCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const createNewsCacheMetadata = (
  source: NewsCacheSource,
  fetchedAt: string,
  baseArchiveEtag: string | null = null,
  newsCount = 0,
): NewsCacheMetadataV2 => ({
  version: NEWS_CACHE_METADATA_VERSION,
  source,
  fetchedAt,
  baseArchiveEtag,
  newsCount,
});

export const parseNewsCacheMetadata = (value: unknown): NewsCacheMetadata | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!isNewsCacheSource(candidate.source) || !isValidTimestamp(candidate.fetchedAt)) return null;

  if (candidate.version === 1) {
    return {
      version: 1,
      source: candidate.source,
      fetchedAt: candidate.fetchedAt,
    };
  }

  if (
    candidate.version !== NEWS_CACHE_METADATA_VERSION ||
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
};

export const isReusableNewsCacheMetadata = (value: unknown): value is NewsCacheMetadataV2 =>
  parseNewsCacheMetadata(value)?.version === 2;

export const toNewsResponseMetadata = (value: unknown): NewsResponseMetadata => {
  const metadata = parseNewsCacheMetadata(value);
  if (!metadata) return { source: "unknown", fetchedAt: null };
  return { source: metadata.source, fetchedAt: metadata.fetchedAt };
};

export const createNewsResponseHeaders = (metadata: unknown): Headers => {
  const responseMetadata = toNewsResponseMetadata(metadata);
  const headers = new Headers({
    "content-type": "application/json; charset=UTF-8",
    [NEWS_SOURCE_HEADER]: responseMetadata.source,
  });
  if (responseMetadata.fetchedAt) {
    headers.set(NEWS_FETCHED_AT_HEADER, responseMetadata.fetchedAt);
  }
  return headers;
};

export const parseNewsResponseHeaders = (headers: Headers): NewsResponseMetadata => {
  const source = headers.get(NEWS_SOURCE_HEADER);
  const fetchedAt = headers.get(NEWS_FETCHED_AT_HEADER);
  const normalizedSource: NewsResponseSource =
    source === "merged" || source === "archive-fallback" || source === "archive-snapshot"
      ? source
      : "unknown";
  return {
    source: normalizedSource,
    fetchedAt: normalizedSource === "unknown" || !isValidTimestamp(fetchedAt) ? null : fetchedAt,
  };
};
