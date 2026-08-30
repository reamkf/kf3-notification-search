import { describe, expect, it } from "vite-plus/test";
import {
  applyNewsRefreshState,
  createNewsCacheMetadata,
  createNewsRefreshState,
  createNewsResponseHeaders,
  isReusableNewsCacheMetadata,
  NEWS_CACHE_METADATA_VERSION,
  NEWS_OFFICIAL_CHECKED_AT_HEADER,
  NEWS_REFRESH_AVAILABLE_AT_HEADER,
  parseNewsCacheMetadata,
  parseNewsRefreshState,
  parseNewsResponseHeaders,
  toNewsResponseMetadata,
} from "../news-response-metadata";

const officialCheckedAt = "2026-08-09T12:34:56.789Z";
const refreshAvailableAt = "2026-08-09T12:39:56.789Z";

const v1Metadata = {
  version: 1,
  source: "merged" as const,
  fetchedAt: officialCheckedAt,
};

describe("news response metadata", () => {
  it("validates and normalizes v2 cache metadata", () => {
    const metadata = createNewsCacheMetadata(
      "archive-fallback",
      officialCheckedAt,
      "archive-etag",
      12,
    );

    expect(parseNewsCacheMetadata(metadata)).toEqual({
      version: NEWS_CACHE_METADATA_VERSION,
      source: "archive-fallback",
      officialCheckedAt,
      baseArchiveEtag: "archive-etag",
      newsCount: 12,
    });
    expect(toNewsResponseMetadata(metadata)).toEqual({
      source: "archive-fallback",
      officialCheckedAt,
      refreshAvailableAt: null,
      dataVersion: null,
    });
    expect(isReusableNewsCacheMetadata(metadata)).toBe(true);
  });

  it("keeps v1 metadata readable without treating fetchedAt as officialCheckedAt", () => {
    expect(parseNewsCacheMetadata(v1Metadata)).toEqual(v1Metadata);
    expect(toNewsResponseMetadata(v1Metadata)).toEqual({
      source: "merged",
      officialCheckedAt: null,
      refreshAvailableAt: null,
      dataVersion: null,
    });
    expect(isReusableNewsCacheMetadata(v1Metadata)).toBe(false);
  });

  it.each([
    null,
    [],
    { version: 3, source: "merged", officialCheckedAt },
    { version: 1, source: "unknown", fetchedAt: officialCheckedAt },
    { version: 1, source: "merged", fetchedAt: "invalid" },
    { version: 2, source: "merged", officialCheckedAt, baseArchiveEtag: "", newsCount: 1 },
    { version: 2, source: "merged", officialCheckedAt: null, baseArchiveEtag: null, newsCount: -1 },
    { version: 2, source: "merged", officialCheckedAt, baseArchiveEtag: null, newsCount: 1.5 },
  ])("不正なmetadataをunknownとして扱う: %#", (metadata) => {
    expect(parseNewsCacheMetadata(metadata)).toBeNull();
    expect(toNewsResponseMetadata(metadata)).toEqual({
      source: "unknown",
      officialCheckedAt: null,
      refreshAvailableAt: null,
      dataVersion: null,
    });
    expect(isReusableNewsCacheMetadata(metadata)).toBe(false);
  });

  it("keeps legacy v2 metadata readable without reusing its request time", () => {
    const metadata = {
      version: 2,
      source: "merged" as const,
      fetchedAt: officialCheckedAt,
      baseArchiveEtag: "archive-etag",
      newsCount: 12,
    };

    expect(parseNewsCacheMetadata(metadata)).toEqual(metadata);
    expect(toNewsResponseMetadata(metadata)).toEqual({
      source: "merged",
      officialCheckedAt: null,
      refreshAvailableAt: null,
      dataVersion: null,
    });
    expect(isReusableNewsCacheMetadata(metadata)).toBe(false);
  });

  it("supports snapshots with a null official ETag or check time", () => {
    const metadata = createNewsCacheMetadata("archive-snapshot", null, null, 3);
    expect(parseNewsCacheMetadata(metadata)).toEqual({
      version: NEWS_CACHE_METADATA_VERSION,
      source: "archive-snapshot",
      officialCheckedAt: null,
      baseArchiveEtag: null,
      newsCount: 3,
    });
    expect(parseNewsResponseHeaders(createNewsResponseHeaders(metadata))).toEqual({
      source: "archive-snapshot",
      officialCheckedAt: null,
      refreshAvailableAt: null,
      dataVersion: null,
    });
  });

  it("merges a matching refresh state without trusting a mismatched state", () => {
    const metadata = createNewsCacheMetadata("merged", null, "archive-etag", 12);
    const state = createNewsRefreshState("archive-etag", officialCheckedAt, refreshAvailableAt);

    expect(applyNewsRefreshState(metadata, state)).toEqual({
      ...metadata,
      officialCheckedAt,
      refreshAvailableAt,
    });
    expect(applyNewsRefreshState(metadata, { ...state, baseArchiveEtag: "other-etag" })).toEqual(
      metadata,
    );
  });

  it("rejects invalid refresh state", () => {
    expect(parseNewsRefreshState('{"version":1,"baseArchiveEtag":null}')).toBeNull();
    expect(parseNewsRefreshState(null)).toBeNull();
  });

  it("creates response headers and reads official and cooldown times back", () => {
    const metadata = {
      ...createNewsCacheMetadata("merged", officialCheckedAt, "archive-etag"),
      refreshAvailableAt,
    };
    const headers = createNewsResponseHeaders(metadata);

    expect(headers.get(NEWS_OFFICIAL_CHECKED_AT_HEADER)).toBe(officialCheckedAt);
    expect(headers.get(NEWS_REFRESH_AVAILABLE_AT_HEADER)).toBe(refreshAvailableAt);
    expect(parseNewsResponseHeaders(headers)).toEqual({
      source: "merged",
      officialCheckedAt,
      refreshAvailableAt,
      dataVersion: "archive-etag",
    });
  });

  it("reads the legacy fetched-at header during wire migration", () => {
    expect(
      parseNewsResponseHeaders(
        new Headers({
          "X-KF3-News-Source": "merged",
          "X-KF3-News-Fetched-At": officialCheckedAt,
        }),
      ),
    ).toMatchObject({ source: "merged", officialCheckedAt });
  });

  it.each([
    {
      headers: {},
      expected: {
        source: "unknown",
        officialCheckedAt: null,
        refreshAvailableAt: null,
        dataVersion: null,
      },
    },
    {
      headers: { "X-KF3-News-Source": "unknown" },
      expected: {
        source: "unknown",
        officialCheckedAt: null,
        refreshAvailableAt: null,
        dataVersion: null,
      },
    },
    {
      headers: {
        "X-KF3-News-Source": "archive-fallback",
        [NEWS_OFFICIAL_CHECKED_AT_HEADER]: "invalid",
        [NEWS_REFRESH_AVAILABLE_AT_HEADER]: "invalid",
      },
      expected: {
        source: "archive-fallback",
        officialCheckedAt: null,
        refreshAvailableAt: null,
        dataVersion: null,
      },
    },
  ])("不正または欠落したheadersを安全に扱う: %#", ({ headers, expected }) => {
    // SAFETY: The test cases provide valid HeadersInit records.
    expect(parseNewsResponseHeaders(new Headers(headers as HeadersInit))).toEqual(expected);
  });
});
