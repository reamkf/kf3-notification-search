import { describe, expect, it } from "vitest";
import {
  NEWS_REFRESH_CONTROL_KEY,
  NEWS_REFRESH_CONTROL_VERSION,
  parseNewsRefreshControl,
  parseRefreshControlState,
} from "../news-refresh-control";

describe("news refresh control metadata", () => {
  it("parses valid legacy control metadata without an ETag", () => {
    expect(
      parseNewsRefreshControl({
        version: NEWS_REFRESH_CONTROL_VERSION,
        status: "running",
        token: "refresh-token",
        leaseUntil: "2026-08-09T12:01:00.000Z",
        cooldownUntil: null,
        lastOutcome: null,
      }),
    ).toEqual({
      version: NEWS_REFRESH_CONTROL_VERSION,
      status: "running",
      token: "refresh-token",
      leaseUntil: "2026-08-09T12:01:00.000Z",
      cooldownUntil: null,
      lastOutcome: null,
    });
    expect(NEWS_REFRESH_CONTROL_KEY).toBe("control/news-refresh.json");
  });

  it("rejects malformed legacy and stored state metadata", () => {
    expect(parseNewsRefreshControl(null)).toBeNull();
    expect(
      parseNewsRefreshControl({
        version: NEWS_REFRESH_CONTROL_VERSION,
        status: "running",
        token: null,
        leaseUntil: null,
        cooldownUntil: null,
        lastOutcome: null,
      }),
    ).toBeNull();
    expect(
      parseNewsRefreshControl({
        version: NEWS_REFRESH_CONTROL_VERSION,
        status: "cooldown",
        token: null,
        leaseUntil: null,
        cooldownUntil: null,
        lastOutcome: "success",
      }),
    ).toBeNull();
    expect(
      parseRefreshControlState({
        status: "idle",
        token: null,
        leaseUntil: null,
        cooldownUntil: null,
        lastOutcome: null,
      }),
    ).not.toBeNull();
    expect(
      parseRefreshControlState({
        status: "cooldown",
        token: "unexpected-token",
        leaseUntil: null,
        cooldownUntil: "2026-08-09T12:05:00.000Z",
        lastOutcome: "success",
      }),
    ).toBeNull();
  });
});
