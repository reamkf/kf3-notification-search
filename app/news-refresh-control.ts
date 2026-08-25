import type { R2Bucket, R2Object } from "@cloudflare/workers-types/experimental";

export const NEWS_REFRESH_CONTROL_KEY = "control/news-refresh.json";
export const NEWS_REFRESH_CONTROL_VERSION = 1;
export const NEWS_REFRESH_LEASE_MS = 60_000;
export const NEWS_REFRESH_COOLDOWN_MS = 5 * 60_000;
export const NEWS_REFRESH_FINALIZATION_LEASE_MS = NEWS_REFRESH_COOLDOWN_MS;

export type NewsRefreshControlStatus = "idle" | "running" | "cooldown";
export type NewsRefreshOutcome = "success" | "failure";

export type NewsRefreshControl = {
  version: typeof NEWS_REFRESH_CONTROL_VERSION;
  status: NewsRefreshControlStatus;
  token: string | null;
  leaseUntil: string | null;
  cooldownUntil: string | null;
  lastOutcome: NewsRefreshOutcome | null;
};

/** The ETag is the CAS capability; leaseToken is persisted control metadata. */
export type NewsRefreshLease = Readonly<{
  leaseToken: string;
  etag: string;
  leaseUntil: string;
}>;

type RefreshControlObject = {
  object: R2Object | null;
  control: NewsRefreshControl | null;
};

export type NewsRefreshAcquireResult =
  | {
      status: "acquired";
      lease: NewsRefreshLease;
    }
  | {
      status: "running";
      retryAfterSeconds: number;
      leaseUntil: string;
    }
  | {
      status: "cooldown";
      retryAfterSeconds: number;
      nextAvailableAt: string;
    };

export type NewsRefreshCompletionResult = "updated" | "lease-mismatch";
export type NewsRefreshRenewalResult = NewsRefreshLease | "inactive" | "lease-mismatch";

const contentType = "application/json; charset=utf-8";
const maxCasAttempts = 5;

const createIfAbsentCondition = () => ({ etagDoesNotMatch: "*" });

const toIso = (timeMs: number) => new Date(timeMs).toISOString();

const parseTime = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const timeMs = Date.parse(value);
  return Number.isFinite(timeMs) ? timeMs : null;
};

const parseControl = (value: unknown): NewsRefreshControl | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== NEWS_REFRESH_CONTROL_VERSION ||
    (candidate.status !== "idle" &&
      candidate.status !== "running" &&
      candidate.status !== "cooldown") ||
    (candidate.token !== null && typeof candidate.token !== "string") ||
    (candidate.leaseUntil !== null && parseTime(candidate.leaseUntil) === null) ||
    (candidate.cooldownUntil !== null && parseTime(candidate.cooldownUntil) === null) ||
    (candidate.lastOutcome !== null &&
      candidate.lastOutcome !== "success" &&
      candidate.lastOutcome !== "failure")
  ) {
    return null;
  }

  if (candidate.status === "running") {
    if (typeof candidate.token !== "string" || parseTime(candidate.leaseUntil) === null)
      return null;
  } else if (candidate.status === "cooldown") {
    if (
      candidate.token !== null ||
      candidate.leaseUntil !== null ||
      parseTime(candidate.cooldownUntil) === null
    ) {
      return null;
    }
  } else if (
    candidate.token !== null ||
    candidate.leaseUntil !== null ||
    candidate.cooldownUntil !== null
  ) {
    return null;
  }

  return {
    version: NEWS_REFRESH_CONTROL_VERSION,
    status: candidate.status,
    token: candidate.token,
    leaseUntil: candidate.leaseUntil as string | null,
    cooldownUntil: candidate.cooldownUntil as string | null,
    lastOutcome: candidate.lastOutcome as NewsRefreshOutcome | null,
  };
};

const readControl = async (bucket: R2Bucket): Promise<RefreshControlObject> => {
  const object = await bucket.get(NEWS_REFRESH_CONTROL_KEY);
  if (!object) return { object: null, control: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await object.text());
  } catch {
    parsed = null;
  }
  return { object, control: parseControl(parsed) };
};

const putControl = async (
  bucket: R2Bucket,
  control: NewsRefreshControl,
  etag: string | null,
): Promise<R2Object | null> =>
  bucket.put(NEWS_REFRESH_CONTROL_KEY, JSON.stringify(control), {
    onlyIf: etag ? { etagMatches: etag } : createIfAbsentCondition(),
    httpMetadata: { contentType },
  });

const secondsUntil = (untilMs: number, nowMs: number) =>
  Math.max(1, Math.ceil(Math.max(0, untilMs - nowMs) / 1000));

const createRunningControl = (token: string, nowMs: number): NewsRefreshControl => ({
  version: NEWS_REFRESH_CONTROL_VERSION,
  status: "running",
  token,
  leaseUntil: toIso(nowMs + NEWS_REFRESH_LEASE_MS),
  cooldownUntil: null,
  lastOutcome: null,
});

export const parseNewsRefreshControl = parseControl;
export const readNewsRefreshControl = readControl;

export const renewNewsRefreshLease = async (
  bucket: R2Bucket,
  lease: NewsRefreshLease,
  nowMs = Date.now(),
  leaseMs = NEWS_REFRESH_LEASE_MS,
): Promise<NewsRefreshRenewalResult> => {
  const currentLeaseUntil = parseTime(lease.leaseUntil);
  if (currentLeaseUntil === null || currentLeaseUntil <= nowMs) return "inactive";

  const nextLeaseUntil = toIso(nowMs + leaseMs);
  const nextControl: NewsRefreshControl = {
    version: NEWS_REFRESH_CONTROL_VERSION,
    status: "running",
    token: lease.leaseToken,
    leaseUntil: nextLeaseUntil,
    cooldownUntil: null,
    lastOutcome: null,
  };
  const result = await putControl(bucket, nextControl, lease.etag);
  if (!result) return "lease-mismatch";
  return { ...lease, etag: result.etag, leaseUntil: nextLeaseUntil };
};

export const acquireNewsRefreshLease = async (
  bucket: R2Bucket,
  nowMs = Date.now(),
): Promise<NewsRefreshAcquireResult> => {
  for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
    const current = await readControl(bucket);
    const control = current.control;
    const leaseUntil = parseTime(control?.leaseUntil);
    if (control?.status === "running" && leaseUntil !== null && leaseUntil > nowMs) {
      return {
        status: "running",
        retryAfterSeconds: secondsUntil(leaseUntil, nowMs),
        leaseUntil: control.leaseUntil!,
      };
    }

    const cooldownUntil = parseTime(control?.cooldownUntil);
    if (control?.status === "cooldown" && cooldownUntil !== null && cooldownUntil > nowMs) {
      return {
        status: "cooldown",
        retryAfterSeconds: secondsUntil(cooldownUntil, nowMs),
        nextAvailableAt: control.cooldownUntil!,
      };
    }

    const token = crypto.randomUUID();
    const nextControl = createRunningControl(token, nowMs);
    const result = await putControl(bucket, nextControl, current.object?.etag ?? null);
    if (result) {
      return {
        status: "acquired",
        lease: { leaseToken: token, etag: result.etag, leaseUntil: nextControl.leaseUntil! },
      };
    }
  }

  const current = await readControl(bucket);
  const leaseUntil = parseTime(current.control?.leaseUntil);
  if (current.control?.status === "running" && leaseUntil !== null && leaseUntil > nowMs) {
    return {
      status: "running",
      retryAfterSeconds: secondsUntil(leaseUntil, nowMs),
      leaseUntil: current.control.leaseUntil!,
    };
  }
  const cooldownUntil = parseTime(current.control?.cooldownUntil);
  if (current.control?.status === "cooldown" && cooldownUntil !== null && cooldownUntil > nowMs) {
    return {
      status: "cooldown",
      retryAfterSeconds: secondsUntil(cooldownUntil, nowMs),
      nextAvailableAt: current.control.cooldownUntil!,
    };
  }
  throw new Error("お知らせ更新制御の取得競合が解消しませんでした");
};

export const completeNewsRefreshLease = async (
  bucket: R2Bucket,
  lease: NewsRefreshLease,
  outcome: NewsRefreshOutcome,
  nowMs = Date.now(),
): Promise<NewsRefreshCompletionResult> => {
  const leaseUntil = parseTime(lease.leaseUntil);
  if (leaseUntil === null || leaseUntil <= nowMs) return "lease-mismatch";

  const nextControl: NewsRefreshControl = {
    version: NEWS_REFRESH_CONTROL_VERSION,
    status: outcome === "success" ? "cooldown" : "idle",
    token: null,
    leaseUntil: null,
    cooldownUntil: outcome === "success" ? toIso(nowMs + NEWS_REFRESH_COOLDOWN_MS) : null,
    lastOutcome: outcome,
  };
  const result = await putControl(bucket, nextControl, lease.etag);
  return result ? "updated" : "lease-mismatch";
};
