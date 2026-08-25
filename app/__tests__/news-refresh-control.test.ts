import { describe, expect, it } from "vitest";
import type { R2Bucket, R2Object, R2ObjectBody } from "@cloudflare/workers-types/experimental";
import {
  NEWS_REFRESH_CONTROL_KEY,
  NEWS_REFRESH_COOLDOWN_MS,
  NEWS_REFRESH_FINALIZATION_LEASE_MS,
  acquireNewsRefreshLease,
  completeNewsRefreshLease,
  parseNewsRefreshControl,
  renewNewsRefreshLease,
} from "../news-refresh-control";

const object = (text: string, etag: string): R2ObjectBody =>
  ({
    etag,
    text: async () => text,
  }) as unknown as R2ObjectBody;

const createBucket = (initial: string | null = null) => {
  let value = initial;
  let etag = initial === null ? null : "etag-1";
  let sequence = 1;
  let getCalls = 0;
  return {
    bucket: {
      get: async () => {
        getCalls += 1;
        return value === null || etag === null ? null : object(value, etag);
      },
      put: async (_key: string, next: string, options?: { onlyIf?: unknown }) => {
        const condition = options?.onlyIf as
          | { etagMatches?: string; etagDoesNotMatch?: string }
          | undefined;
        if (condition?.etagDoesNotMatch === "*" ? value !== null : false) return null;
        if (
          condition?.etagDoesNotMatch !== undefined &&
          condition.etagDoesNotMatch !== "*" &&
          etag === condition.etagDoesNotMatch
        )
          return null;
        if (condition?.etagMatches !== undefined && condition.etagMatches !== etag) return null;
        value = next;
        etag = `etag-${++sequence}`;
        return { etag } as R2Object;
      },
    } as unknown as R2Bucket,
    read: () => (value === null ? null : JSON.parse(value)),
    getCalls: () => getCalls,
  };
};

describe("news refresh control", () => {
  it("acquires a lease and recovers an expired lease", async () => {
    const setup = createBucket();
    const first = await acquireNewsRefreshLease(setup.bucket, 0);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;

    const running = await acquireNewsRefreshLease(setup.bucket, 1);
    expect(running.status).toBe("running");

    const recovered = await acquireNewsRefreshLease(setup.bucket, 61_000);
    expect(recovered.status).toBe("acquired");
    if (recovered.status === "acquired") {
      expect(recovered.lease.leaseToken).not.toBe(first.lease.leaseToken);
    }
  });

  it("renews the active lease before finalization without reviving expired leases", async () => {
    const setup = createBucket();
    const acquired = await acquireNewsRefreshLease(setup.bucket, 0);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;

    const renewed = await renewNewsRefreshLease(
      setup.bucket,
      acquired.lease,
      59_000,
      NEWS_REFRESH_FINALIZATION_LEASE_MS,
    );
    expect(renewed).toMatchObject({
      leaseToken: acquired.lease.leaseToken,
      leaseUntil: new Date(59_000 + NEWS_REFRESH_FINALIZATION_LEASE_MS).toISOString(),
    });
    expect(setup.getCalls()).toBe(1);
    expect(setup.read()).toMatchObject({
      status: "running",
      token: acquired.lease.leaseToken,
      leaseUntil: new Date(59_000 + NEWS_REFRESH_FINALIZATION_LEASE_MS).toISOString(),
    });
    expect(await acquireNewsRefreshLease(setup.bucket, 61_000)).toMatchObject({
      status: "running",
    });

    const expired = createBucket(
      JSON.stringify({
        version: 1,
        status: "running",
        token: "expired-token",
        leaseUntil: new Date(60_000).toISOString(),
        cooldownUntil: null,
        lastOutcome: null,
      }),
    );
    expect(
      await renewNewsRefreshLease(
        expired.bucket,
        {
          leaseToken: "expired-token",
          etag: "etag-1",
          leaseUntil: new Date(60_000).toISOString(),
        },
        60_000,
      ),
    ).toBe("inactive");
  });

  it("returns cooldown only after a successful lease-matched completion", async () => {
    const setup = createBucket();
    const acquired = await acquireNewsRefreshLease(setup.bucket, 1000);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;

    expect(
      await completeNewsRefreshLease(
        setup.bucket,
        { ...acquired.lease, etag: "wrong-etag" },
        "success",
        1000,
      ),
    ).toBe("lease-mismatch");
    expect(setup.getCalls()).toBe(1);
    expect(await completeNewsRefreshLease(setup.bucket, acquired.lease, "success", 1000)).toBe(
      "updated",
    );
    expect(setup.getCalls()).toBe(1);

    const cooldown = await acquireNewsRefreshLease(setup.bucket, 1001);
    expect(cooldown.status).toBe("cooldown");
    if (cooldown.status === "cooldown") {
      expect(cooldown.retryAfterSeconds).toBe(Math.ceil(NEWS_REFRESH_COOLDOWN_MS / 1000));
    }

    const next = await acquireNewsRefreshLease(setup.bucket, 301_001);
    expect(next.status).toBe("acquired");
  });

  it("does not complete an expired lease", async () => {
    const setup = createBucket();
    const acquired = await acquireNewsRefreshLease(setup.bucket, 0);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;

    expect(await completeNewsRefreshLease(setup.bucket, acquired.lease, "success", 60_000)).toBe(
      "lease-mismatch",
    );
    expect(setup.read()).toMatchObject({ status: "running", token: acquired.lease.leaseToken });
  });

  it("does not start cooldown for a failed refresh", async () => {
    const setup = createBucket();
    const acquired = await acquireNewsRefreshLease(setup.bucket, 0);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;

    expect(await completeNewsRefreshLease(setup.bucket, acquired.lease, "failure", 0)).toBe(
      "updated",
    );
    expect(setup.read()).toMatchObject({ status: "idle", lastOutcome: "failure" });
    expect(await acquireNewsRefreshLease(setup.bucket, 1)).toMatchObject({ status: "acquired" });
  });

  it("rejects malformed control metadata", () => {
    expect(parseNewsRefreshControl(null)).toBeNull();
    expect(
      parseNewsRefreshControl({
        version: 1,
        status: "running",
        token: null,
        leaseUntil: null,
        cooldownUntil: null,
        lastOutcome: null,
      }),
    ).toBeNull();
    expect(
      parseNewsRefreshControl({
        version: 1,
        status: "cooldown",
        token: null,
        leaseUntil: null,
        cooldownUntil: null,
        lastOutcome: "success",
      }),
    ).toBeNull();
    expect(NEWS_REFRESH_CONTROL_KEY).toBe("control/news-refresh.json");
  });
});
