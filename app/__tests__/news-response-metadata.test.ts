import { describe, expect, it } from "vitest";
import {
  createNewsCacheMetadata,
  createNewsResponseHeaders,
  isReusableNewsCacheMetadata,
  NEWS_CACHE_METADATA_VERSION,
  parseNewsCacheMetadata,
  parseNewsResponseHeaders,
  toNewsResponseMetadata,
} from "../news-response-metadata";

const fetchedAt = "2026-08-09T12:34:56.789Z";

const v1Metadata = {
  version: 1,
  source: "merged" as const,
  fetchedAt,
};

describe("news response metadata", () => {
  it("validates and normalizes v2 cache metadata", () => {
    const metadata = createNewsCacheMetadata("archive-fallback", fetchedAt, "archive-etag", 12);

    expect(parseNewsCacheMetadata(metadata)).toEqual({
      version: NEWS_CACHE_METADATA_VERSION,
      source: "archive-fallback",
      fetchedAt,
      baseArchiveEtag: "archive-etag",
      newsCount: 12,
    });
    expect(toNewsResponseMetadata(metadata)).toEqual({
      source: "archive-fallback",
      fetchedAt,
    });
    expect(isReusableNewsCacheMetadata(metadata)).toBe(true);
  });

  it("keeps v1 metadata readable but not reusable", () => {
    expect(parseNewsCacheMetadata(v1Metadata)).toEqual(v1Metadata);
    expect(toNewsResponseMetadata(v1Metadata)).toEqual({ source: "merged", fetchedAt });
    expect(isReusableNewsCacheMetadata(v1Metadata)).toBe(false);
  });

  it.each([
    null,
    [],
    { version: 3, source: "merged", fetchedAt },
    { version: 1, source: "unknown", fetchedAt },
    { version: 1, source: "merged", fetchedAt: "invalid" },
    { version: 2, source: "merged", fetchedAt, baseArchiveEtag: "", newsCount: 1 },
    { version: 2, source: "merged", fetchedAt, baseArchiveEtag: null, newsCount: -1 },
    { version: 2, source: "merged", fetchedAt, baseArchiveEtag: null, newsCount: 1.5 },
  ])("不正なmetadataをunknownとして扱う: %#", (metadata) => {
    expect(parseNewsCacheMetadata(metadata)).toBeNull();
    expect(toNewsResponseMetadata(metadata)).toEqual({ source: "unknown", fetchedAt: null });
    expect(isReusableNewsCacheMetadata(metadata)).toBe(false);
  });

  it("supports legacy snapshots with a null archive ETag", () => {
    const metadata = createNewsCacheMetadata("archive-snapshot", fetchedAt, null, 3);
    expect(parseNewsCacheMetadata(metadata)).toEqual({
      version: NEWS_CACHE_METADATA_VERSION,
      source: "archive-snapshot",
      fetchedAt,
      baseArchiveEtag: null,
      newsCount: 3,
    });
    expect(parseNewsResponseHeaders(createNewsResponseHeaders(metadata))).toEqual({
      source: "archive-snapshot",
      fetchedAt,
    });
  });

  it("creates response headers and reads them back", () => {
    const headers = createNewsResponseHeaders(createNewsCacheMetadata("merged", fetchedAt));

    expect(parseNewsResponseHeaders(headers)).toEqual({ source: "merged", fetchedAt });
  });

  it.each([
    { headers: {}, expected: { source: "unknown", fetchedAt: null } },
    {
      headers: { "X-KF3-News-Source": "unknown" },
      expected: { source: "unknown", fetchedAt: null },
    },
    {
      headers: { "X-KF3-News-Source": "archive-fallback", "X-KF3-News-Fetched-At": "invalid" },
      expected: { source: "archive-fallback", fetchedAt: null },
    },
  ])("不正または欠落したheadersを安全に扱う: %#", ({ headers, expected }) => {
    expect(parseNewsResponseHeaders(new Headers(headers as HeadersInit))).toEqual(expected);
  });
});
