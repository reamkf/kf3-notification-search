import type { Fetcher, KVNamespace, Queue, R2Bucket } from "@cloudflare/workers-types/experimental";
import type { NewsArchiveUpdateMessage } from "./news-archive-queue";

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
      HEALTHCHECKS_PING_URL?: string;
    };
  }
  interface ContextRenderer {
    (content: string | Promise<string>, head?: Head): Response | Promise<Response>;
  }
}
