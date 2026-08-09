export const NEWS_SOURCE_HEADER = "X-KF3-News-Source";
export const NEWS_FETCHED_AT_HEADER = "X-KF3-News-Fetched-At";
export const NEWS_CACHE_METADATA_VERSION = 1;

export type NewsCacheSource = "merged" | "archive-fallback";
export type NewsResponseSource = NewsCacheSource | "unknown";

export type NewsCacheMetadata = {
  version: typeof NEWS_CACHE_METADATA_VERSION;
  source: NewsCacheSource;
  fetchedAt: string;
};

export type NewsResponseMetadata = {
  source: NewsResponseSource;
  fetchedAt: string | null;
};

const isValidTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export const createNewsCacheMetadata = (
  source: NewsCacheSource,
  fetchedAt: string,
): NewsCacheMetadata => ({
  version: NEWS_CACHE_METADATA_VERSION,
  source,
  fetchedAt,
});

export const parseNewsCacheMetadata = (value: unknown): NewsCacheMetadata | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== NEWS_CACHE_METADATA_VERSION ||
    (candidate.source !== "merged" && candidate.source !== "archive-fallback") ||
    !isValidTimestamp(candidate.fetchedAt)
  ) {
    return null;
  }
  return {
    version: NEWS_CACHE_METADATA_VERSION,
    source: candidate.source,
    fetchedAt: candidate.fetchedAt,
  };
};

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
    source === "merged" || source === "archive-fallback" ? source : "unknown";
  return {
    source: normalizedSource,
    fetchedAt: normalizedSource === "unknown" || !isValidTimestamp(fetchedAt) ? null : fetchedAt,
  };
};
