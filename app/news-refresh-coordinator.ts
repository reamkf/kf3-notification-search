import { DurableObject } from "cloudflare:workers";
import {
  NEWS_REFRESH_CONTROL_KEY,
  NEWS_REFRESH_COOLDOWN_MS,
  NEWS_REFRESH_LEASE_MS,
  createIdleRefreshControlState,
  parseNewsRefreshControl,
  parseRefreshControlState,
  parseRefreshControlTime,
  refreshControlToIso,
  refreshSecondsUntil,
  type NewsRefreshAcquireResult,
  type NewsRefreshCompletionResult,
  type NewsRefreshOutcome,
  type NewsRefreshRenewalResult,
  type RefreshControlState,
} from "./news-refresh-control";

const tableName = "refresh_control";

type RefreshControlRow = {
  status: string;
  token: string | null;
  lease_until: string | null;
  cooldown_until: string | null;
  last_outcome: string | null;
};

const toState = (row: RefreshControlRow): RefreshControlState | null =>
  parseRefreshControlState({
    status: row.status,
    token: row.token,
    leaseUntil: row.lease_until,
    cooldownUntil: row.cooldown_until,
    lastOutcome: row.last_outcome,
  });

const toLegacyState = (control: ReturnType<typeof parseNewsRefreshControl>) =>
  control
    ? {
        status: control.status,
        token: control.token,
        leaseUntil: control.leaseUntil,
        cooldownUntil: control.cooldownUntil,
        lastOutcome: control.lastOutcome,
      }
    : createIdleRefreshControlState();

export class NewsRefreshCoordinator extends DurableObject<WorkerBindings> {
  private state: RefreshControlState | null = null;
  private bootstrapPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          status TEXT NOT NULL,
          token TEXT,
          lease_until TEXT,
          cooldown_until TEXT,
          last_outcome TEXT
        )
      `);
    });
  }

  private readState(): RefreshControlState | null {
    const row = this.ctx.storage.sql
      .exec<RefreshControlRow>(
        `SELECT status, token, lease_until, cooldown_until, last_outcome FROM ${tableName} WHERE id = 1`,
      )
      .toArray()[0];
    return row ? toState(row) : null;
  }

  private writeState(state: RefreshControlState): void {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO ${tableName} (id, status, token, lease_until, cooldown_until, last_outcome)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          token = excluded.token,
          lease_until = excluded.lease_until,
          cooldown_until = excluded.cooldown_until,
          last_outcome = excluded.last_outcome
      `,
      state.status,
      state.token,
      state.leaseUntil,
      state.cooldownUntil,
      state.lastOutcome,
    );
    this.state = state;
  }

  private async bootstrap(): Promise<void> {
    const object = await this.env.KF3_NOTIF_DATA.get(NEWS_REFRESH_CONTROL_KEY);
    let state = createIdleRefreshControlState();
    if (object) {
      const text = await object.text();
      try {
        state = toLegacyState(parseNewsRefreshControl(JSON.parse(text)));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    this.writeState(state);
  }

  private async ensureBootstrapped(): Promise<void> {
    if (this.state) return;
    const stored = this.readState();
    if (stored) {
      this.state = stored;
      return;
    }
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrap().catch((error) => {
        this.bootstrapPromise = null;
        throw error;
      });
    }
    await this.bootstrapPromise;
  }

  async acquire(nowMs: number): Promise<NewsRefreshAcquireResult> {
    await this.ensureBootstrapped();
    const current = this.state!;
    const leaseUntil = parseRefreshControlTime(current.leaseUntil);
    if (current.status === "running" && leaseUntil !== null && leaseUntil > nowMs) {
      return {
        status: "running",
        retryAfterSeconds: refreshSecondsUntil(leaseUntil, nowMs),
        leaseUntil: current.leaseUntil!,
      };
    }

    const cooldownUntil = parseRefreshControlTime(current.cooldownUntil);
    if (current.status === "cooldown" && cooldownUntil !== null && cooldownUntil > nowMs) {
      return {
        status: "cooldown",
        retryAfterSeconds: refreshSecondsUntil(cooldownUntil, nowMs),
        nextAvailableAt: current.cooldownUntil!,
      };
    }

    const token = crypto.randomUUID();
    const nextState: RefreshControlState = {
      status: "running",
      token,
      leaseUntil: refreshControlToIso(nowMs + NEWS_REFRESH_LEASE_MS),
      cooldownUntil: null,
      lastOutcome: null,
    };
    this.writeState(nextState);
    return {
      status: "acquired",
      lease: { leaseToken: token, leaseUntil: nextState.leaseUntil! },
    };
  }

  async renew(
    token: string,
    nowMs: number,
    leaseMs = NEWS_REFRESH_LEASE_MS,
  ): Promise<NewsRefreshRenewalResult> {
    await this.ensureBootstrapped();
    const current = this.state!;
    if (current.status !== "running" || current.token !== token) return "lease-mismatch";
    const leaseUntil = parseRefreshControlTime(current.leaseUntil);
    if (leaseUntil === null || leaseUntil <= nowMs) return "inactive";

    const nextLeaseUntil = refreshControlToIso(nowMs + leaseMs);
    this.writeState({ ...current, leaseUntil: nextLeaseUntil, lastOutcome: null });
    return { leaseToken: token, leaseUntil: nextLeaseUntil };
  }

  async complete(
    token: string,
    outcome: NewsRefreshOutcome,
    nowMs: number,
  ): Promise<NewsRefreshCompletionResult> {
    await this.ensureBootstrapped();
    const current = this.state!;
    if (current.status !== "running" || current.token !== token) return "lease-mismatch";
    const leaseUntil = parseRefreshControlTime(current.leaseUntil);
    if (leaseUntil === null || leaseUntil <= nowMs) return "lease-mismatch";

    this.writeState({
      status: outcome === "success" ? "cooldown" : "idle",
      token: null,
      leaseUntil: null,
      cooldownUntil:
        outcome === "success" ? refreshControlToIso(nowMs + NEWS_REFRESH_COOLDOWN_MS) : null,
      lastOutcome: outcome,
    });
    return "updated";
  }
}
