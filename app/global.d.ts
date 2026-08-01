import {
  Fetcher,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types/experimental";

type Head = {
  title?: string;
};

declare module "hono" {
  interface Env {
    Variables: {};
    Bindings: {
      ASSETS: Fetcher;
      KF3_NOTIF_CACHE: KVNamespace;
      KF3_NOTIF_DATA: R2Bucket;
    };
  }
  interface ContextRenderer {
    (content: string | Promise<string>, head?: Head):
      | Response
      | Promise<Response>;
  }
}
