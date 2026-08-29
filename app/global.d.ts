import type {
  DurableObjectNamespace,
  Fetcher,
  KVNamespace,
  Queue,
  R2Bucket,
  WorkerVersionMetadata,
} from "@cloudflare/workers-types/experimental";
import type { NewsArchiveUpdateMessage } from "./news-archive-queue";
import type { NewsRefreshCoordinator } from "./news-refresh-coordinator";

type Head = {
  title?: string;
};

declare global {
  type WorkerBindings = {
    ASSETS: Fetcher;
    KF3_NOTIF_CACHE: KVNamespace;
    KF3_NOTIF_DATA: R2Bucket;
    KF3_NOTIF_BACKUP: R2Bucket;
    KF3_ARCHIVE_UPDATE_QUEUE: Queue<NewsArchiveUpdateMessage>;
    KF3_REFRESH_COORDINATOR: DurableObjectNamespace<NewsRefreshCoordinator>;
    CF_VERSION_METADATA?: WorkerVersionMetadata;
    HEALTHCHECKS_PING_URL?: string;
  };
}

declare module "hono" {
  interface Env {
    Variables: {};
    Bindings: {
      ASSETS: Fetcher;
      KF3_NOTIF_CACHE: KVNamespace;
      KF3_NOTIF_DATA: R2Bucket;
      KF3_NOTIF_BACKUP: R2Bucket;
      KF3_ARCHIVE_UPDATE_QUEUE: Queue<NewsArchiveUpdateMessage>;
      KF3_REFRESH_COORDINATOR: DurableObjectNamespace<NewsRefreshCoordinator>;
      CF_VERSION_METADATA?: WorkerVersionMetadata;
      HEALTHCHECKS_PING_URL?: string;
    };
  }
  interface ContextRenderer {
    (content: string | Promise<string>, head?: Head): Response | Promise<Response>;
  }
}
