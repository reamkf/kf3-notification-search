import type { Response } from "@cloudflare/workers-types";
import { createApp } from "honox/server";
import { createNewsApp, createWorkerHandler } from "./server";

export { NewsRefreshCoordinator } from "./news-refresh-coordinator";

const app = createApp({ app: createNewsApp({}) });
const worker = createWorkerHandler();
const viteClientScript = '<script type="module">import("/@vite/client")</script>';
const fetch: NonNullable<typeof worker.fetch> = async (request, env, executionContext) => {
  const response = (await app.fetch(
    request as unknown as globalThis.Request,
    env,
    executionContext as unknown as globalThis.ExecutionContext,
  )) as unknown as globalThis.Response;
  if (!response.headers.get("content-type")?.startsWith("text/html"))
    return response as unknown as Response;

  const body = await response.text();
  if (body.includes("/@vite/client")) return response as unknown as Response;
  const html = body.includes("</body>")
    ? body.replace("</body>", `${viteClientScript}</body>`)
    : `${body}${viteClientScript}`;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new globalThis.Response(html, {
    headers,
    status: response.status,
    statusText: response.statusText,
  }) as unknown as Response;
};

export default { ...worker, fetch };
