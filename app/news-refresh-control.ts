import * as v from "valibot";
import type { JsonInput } from "./schema";

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

const timestampSchema = v.pipe(
  v.string(),
  v.check((value) => Number.isFinite(Date.parse(value))),
);
const statusSchema = v.union([v.literal("idle"), v.literal("running"), v.literal("cooldown")]);
const outcomeSchema = v.nullable(v.union([v.literal("success"), v.literal("failure")]));
const refreshControlStateSchema = v.object({
  status: statusSchema,
  token: v.nullable(v.string()),
  leaseUntil: v.nullable(timestampSchema),
  cooldownUntil: v.nullable(timestampSchema),
  lastOutcome: outcomeSchema,
});
const refreshControlSchema = v.object({
  version: v.literal(NEWS_REFRESH_CONTROL_VERSION),
  status: statusSchema,
  token: v.nullable(v.string()),
  leaseUntil: v.nullable(timestampSchema),
  cooldownUntil: v.nullable(timestampSchema),
  lastOutcome: outcomeSchema,
});

const toTime = (value: JsonInput): number | null => {
  const result = v.safeParse(timestampSchema, value);
  return result.success ? Date.parse(result.output) : null;
};

const validateState = (candidate: RefreshControlState): RefreshControlState | null => {
  if (candidate.status === "running") {
    if (candidate.token === null || candidate.leaseUntil === null) return null;
  } else if (candidate.status === "cooldown") {
    if (
      candidate.token !== null ||
      candidate.leaseUntil !== null ||
      candidate.cooldownUntil === null
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
  return candidate;
};

const parseState = (value: JsonInput): RefreshControlState | null => {
  const result = v.safeParse(refreshControlStateSchema, value);
  return result.success ? validateState(result.output) : null;
};

export const parseRefreshControlState = parseState;

export const parseNewsRefreshControl = (value: JsonInput): NewsRefreshControl | null => {
  const result = v.safeParse(refreshControlSchema, value);
  if (!result.success) return null;
  const state = validateState(result.output);
  return state === null ? null : { version: result.output.version, ...state };
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
