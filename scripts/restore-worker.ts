import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types/experimental";
import { CURRENT_ARCHIVE_KEY } from "../app/news-archive";
import { NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY, NEWS_CACHE_KEY } from "../app/news-cache-keys";
import { canonicalizeNewsDocument, parseJapaneseNewsDate } from "../app/news-data";

const cacheKey = NEWS_CACHE_KEY;
const snapshotKeyPattern =
  /^(?:daily\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._-]+|monthly\/\d{4}-\d{2})\.json$/;

export type RestoreBindings = {
  KF3_NOTIF_CACHE: KVNamespace;
  KF3_NOTIF_DATA: R2Bucket;
  KF3_NOTIF_BACKUP: R2Bucket;
};

type RestoreMode = "dry-run" | "apply";

type RestoreInput = {
  mode: RestoreMode;
  snapshotKey: string;
  snapshotDigest?: string;
  currentEtag?: string;
};

type SnapshotSummary = {
  key: string;
  digest: string;
  count: number;
  oldestNewsDate: string | null;
  newestNewsDate: string | null;
  normalizedJson: string;
};

class RestoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RestoreError";
  }
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const isLocalRequest = (request: Request) => {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
};

const parseRestoreInput = async (request: Request): Promise<RestoreInput> => {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new RestoreError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RestoreError(400, "invalid_request", "Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  const mode = body.mode ?? "dry-run";
  if (mode !== "dry-run" && mode !== "apply") {
    throw new RestoreError(400, "invalid_mode", "mode must be dry-run or apply");
  }
  if (typeof body.snapshotKey !== "string" || !snapshotKeyPattern.test(body.snapshotKey)) {
    throw new RestoreError(
      400,
      "invalid_snapshot_key",
      "snapshotKey must identify a daily or monthly JSON snapshot",
    );
  }
  if (body.snapshotDigest !== undefined && typeof body.snapshotDigest !== "string") {
    throw new RestoreError(400, "invalid_snapshot_digest", "snapshotDigest must be a string");
  }
  if (body.currentEtag !== undefined && typeof body.currentEtag !== "string") {
    throw new RestoreError(400, "invalid_current_etag", "currentEtag must be a string");
  }
  return {
    mode,
    snapshotKey: body.snapshotKey,
    snapshotDigest: body.snapshotDigest,
    currentEtag: body.currentEtag,
  };
};

const readSnapshot = async (bucket: R2Bucket, snapshotKey: string): Promise<SnapshotSummary> => {
  let object;
  try {
    object = await bucket.get(snapshotKey);
  } catch {
    throw new RestoreError(502, "snapshot_read_failed", "Failed to read the snapshot");
  }
  if (!object) throw new RestoreError(404, "snapshot_not_found", "Snapshot was not found");

  let text: string;
  try {
    text = await object.text();
  } catch {
    throw new RestoreError(502, "snapshot_read_failed", "Failed to read the snapshot");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RestoreError(422, "snapshot_json_invalid", "Snapshot is not valid JSON");
  }

  let canonical;
  try {
    canonical = await canonicalizeNewsDocument(parsed);
  } catch {
    throw new RestoreError(422, "snapshot_validation_failed", "Snapshot validation failed");
  }

  let oldestNewsDate: string | null = null;
  let newestNewsDate: string | null = null;
  let oldestTime = Number.POSITIVE_INFINITY;
  let newestTime = Number.NEGATIVE_INFINITY;
  for (const news of canonical.document.news) {
    const time = parseJapaneseNewsDate(news.newsDate);
    if (time < oldestTime) {
      oldestTime = time;
      oldestNewsDate = news.newsDate;
    }
    if (time > newestTime) {
      newestTime = time;
      newestNewsDate = news.newsDate;
    }
  }

  return {
    key: snapshotKey,
    digest: canonical.digest,
    count: canonical.document.news.length,
    oldestNewsDate,
    newestNewsDate,
    normalizedJson: canonical.normalizedJson,
  };
};

const readCurrentEtag = async (bucket: R2Bucket) => {
  let current;
  try {
    current = await bucket.head(CURRENT_ARCHIVE_KEY);
  } catch {
    throw new RestoreError(
      502,
      "current_read_failed",
      "Failed to read the current archive metadata",
    );
  }
  if (!current) {
    throw new RestoreError(409, "current_not_found", "Current archive does not exist");
  }
  return current.etag;
};

const publicSnapshotSummary = (snapshot: SnapshotSummary) => ({
  key: snapshot.key,
  digest: snapshot.digest,
  count: snapshot.count,
  oldestNewsDate: snapshot.oldestNewsDate,
  newestNewsDate: snapshot.newestNewsDate,
});

const restore = async (input: RestoreInput, env: RestoreBindings) => {
  const snapshot = await readSnapshot(env.KF3_NOTIF_BACKUP, input.snapshotKey);
  const latestCurrentEtag = await readCurrentEtag(env.KF3_NOTIF_DATA);

  if (input.mode === "dry-run") {
    return {
      mode: "dry-run",
      snapshot: publicSnapshotSummary(snapshot),
      current: { key: CURRENT_ARCHIVE_KEY, etag: latestCurrentEtag },
      plannedOperations: [
        "conditionally replace archive/current.json",
        "delete KV kf3-news after a successful replacement",
      ],
      writes: { r2Puts: 0, kvDeletes: 0 },
    };
  }

  if (!input.snapshotDigest || !input.currentEtag) {
    throw new RestoreError(
      400,
      "apply_confirmation_required",
      "apply requires snapshotDigest and currentEtag from the latest dry-run",
    );
  }
  if (input.snapshotDigest !== snapshot.digest) {
    throw new RestoreError(409, "snapshot_digest_mismatch", "Snapshot digest does not match");
  }
  if (input.currentEtag !== latestCurrentEtag) {
    throw new RestoreError(409, "current_etag_mismatch", "Current archive ETag does not match");
  }

  let updated;
  try {
    updated = await env.KF3_NOTIF_DATA.put(CURRENT_ARCHIVE_KEY, snapshot.normalizedJson, {
      onlyIf: { etagMatches: input.currentEtag },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch {
    throw new RestoreError(502, "current_put_failed", "Failed to update the current archive");
  }
  if (!updated) {
    throw new RestoreError(
      409,
      "current_update_conflict",
      "Current archive changed during restore",
    );
  }

  const cacheDeletions = await Promise.allSettled([
    Promise.resolve().then(() => env.KF3_NOTIF_CACHE.delete(NEWS_ARCHIVE_SNAPSHOT_CACHE_KEY)),
    Promise.resolve().then(() => env.KF3_NOTIF_CACHE.delete(cacheKey)),
  ]);
  if (cacheDeletions.some((result) => result.status === "rejected")) {
    throw new RestoreError(
      502,
      "cache_delete_failed",
      "Current archive was restored but cache deletion failed",
      {
        updatedEtag: updated.etag,
      },
    );
  }

  return {
    mode: "apply",
    snapshot: publicSnapshotSummary(snapshot),
    previousCurrentEtag: latestCurrentEtag,
    updatedCurrentEtag: updated.etag,
    writes: { r2Puts: 1, kvDeletes: 2 },
  };
};

export const handleRestoreRequest = async (request: Request, env: RestoreBindings) => {
  if (!isLocalRequest(request)) {
    return jsonResponse(
      { error: { code: "localhost_only", message: "Restore tool is localhost-only" } },
      403,
    );
  }
  const url = new URL(request.url);
  if (url.pathname !== "/restore") {
    return jsonResponse({ error: { code: "not_found", message: "Use POST /restore" } }, 404);
  }
  if (request.method !== "POST") {
    return jsonResponse(
      { error: { code: "method_not_allowed", message: "Use POST /restore" } },
      405,
    );
  }

  try {
    return jsonResponse(await restore(await parseRestoreInput(request), env));
  } catch (error) {
    const restoreError =
      error instanceof RestoreError
        ? error
        : new RestoreError(500, "restore_failed", "Restore operation failed");
    return jsonResponse(
      {
        error: {
          code: restoreError.code,
          message: restoreError.message,
          ...restoreError.details,
        },
      },
      restoreError.status,
    );
  }
};

export default {
  fetch: handleRestoreRequest,
};
