import { describe, expect, it } from "vitest";
import {
  createNewsCacheMetadata,
  createNewsResponseHeaders,
  NEWS_CACHE_METADATA_VERSION,
  parseNewsCacheMetadata,
  parseNewsResponseHeaders,
  toNewsResponseMetadata,
} from "../news-response-metadata";

const fetchedAt = "2026-08-09T12:34:56.789Z";

describe("news response metadata", () => {
  it("validates and normalizes cache metadata", () => {
    const metadata = createNewsCacheMetadata("archive-fallback", fetchedAt);

    expect(parseNewsCacheMetadata(metadata)).toEqual({
      version: NEWS_CACHE_METADATA_VERSION,
      source: "archive-fallback",
      fetchedAt,
    });
    expect(toNewsResponseMetadata(metadata)).toEqual({
      source: "archive-fallback",
      fetchedAt,
    });
  });

  it.each([
    null,
    [],
    { version: 2, source: "merged", fetchedAt },
    { version: 1, source: "unknown", fetchedAt },
    { version: 1, source: "merged", fetchedAt: "invalid" },
  ])("不正なmetadataをunknownとして扱う: %#", (metadata) => {
    expect(parseNewsCacheMetadata(metadata)).toBeNull();
    expect(toNewsResponseMetadata(metadata)).toEqual({ source: "unknown", fetchedAt: null });
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
