export const NEWS_REFRESH_CONTROL_KEY = "control/news-refresh.json";
export const NEWS_REFRESH_CONTROL_VERSION = 1;
export const NEWS_REFRESH_LEASE_MS = 60_000;
export const NEWS_REFRESH_COOLDOWN_MS = 5 * 60_000;
export const NEWS_REFRESH_FINALIZATION_LEASE_MS = NEWS_REFRESH_COOLDOWN_MS;

export type NewsRefreshControlStatus = "idle" | "running" | "cooldown";
export type NewsRefreshOutcome = "success" | "failure";

export type RefreshControlState = {
  status: NewsRefreshControlStatus;
  token: string | null;
  leaseUntil: string | null;
  cooldownUntil: string | null;
  lastOutcome: NewsRefreshOutcome | null;
};

export type NewsRefreshControl = RefreshControlState & {
  version: typeof NEWS_REFRESH_CONTROL_VERSION;
};

export type NewsRefreshLease = Readonly<{
  leaseToken: string;
  leaseUntil: string;
}>;

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

const toTime = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const timeMs = Date.parse(value);
  return Number.isFinite(timeMs) ? timeMs : null;
};

const parseState = (value: unknown): RefreshControlState | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.status !== "idle" &&
      candidate.status !== "running" &&
      candidate.status !== "cooldown") ||
    (candidate.token !== null && typeof candidate.token !== "string") ||
    (candidate.leaseUntil !== null && toTime(candidate.leaseUntil) === null) ||
    (candidate.cooldownUntil !== null && toTime(candidate.cooldownUntil) === null) ||
    (candidate.lastOutcome !== null &&
      candidate.lastOutcome !== "success" &&
      candidate.lastOutcome !== "failure")
  ) {
    return null;
  }

  if (candidate.status === "running") {
    if (typeof candidate.token !== "string" || toTime(candidate.leaseUntil) === null) return null;
  } else if (candidate.status === "cooldown") {
    if (
      candidate.token !== null ||
      candidate.leaseUntil !== null ||
      toTime(candidate.cooldownUntil) === null
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
    status: candidate.status,
    token: candidate.token as string | null,
    leaseUntil: candidate.leaseUntil as string | null,
    cooldownUntil: candidate.cooldownUntil as string | null,
    lastOutcome: candidate.lastOutcome as NewsRefreshOutcome | null,
  };
};

export const parseRefreshControlState = parseState;

export const parseNewsRefreshControl = (value: unknown): NewsRefreshControl | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== NEWS_REFRESH_CONTROL_VERSION) return null;
  const state = parseState(candidate);
  return state ? { version: NEWS_REFRESH_CONTROL_VERSION, ...state } : null;
};

export const createIdleRefreshControlState = (): RefreshControlState => ({
  status: "idle",
  token: null,
  leaseUntil: null,
  cooldownUntil: null,
  lastOutcome: null,
});

export const parseRefreshControlTime = toTime;

export const refreshSecondsUntil = (untilMs: number, nowMs: number) =>
  Math.max(1, Math.ceil(Math.max(0, untilMs - nowMs) / 1000));

export const refreshControlToIso = (timeMs: number) => new Date(timeMs).toISOString();
