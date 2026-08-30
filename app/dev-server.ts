import type { Response } from "@cloudflare/workers-types";
import { createApp } from "honox/server";
import { createNewsApp, createWorkerHandler } from "./server";
import { bridgeRuntimeValue } from "./runtime-value";

export { NewsRefreshCoordinator } from "./news-refresh-coordinator";

const app = createApp({ app: createNewsApp({}) });
const worker = createWorkerHandler();
const viteClientScript = '<script type="module">import("/@vite/client")</script>';

const fetch: NonNullable<typeof worker.fetch> = async (request, env, executionContext) => {
  const response = bridgeRuntimeValue<globalThis.Response>(
    await app.fetch(
      bridgeRuntimeValue<globalThis.Request>(request),
      env,
      bridgeRuntimeValue<globalThis.ExecutionContext>(executionContext),
    ),
  );
  if (!response.headers.get("content-type")?.startsWith("text/html")) {
    return bridgeRuntimeValue<Response>(response);
  }

  const body = await response.text();
  if (body.includes("/@vite/client")) {
    return bridgeRuntimeValue<Response>(response);
  }
  const html = body.includes("</body>")
    ? body.replace("</body>", `${viteClientScript}</body>`)
    : `${body}${viteClientScript}`;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return bridgeRuntimeValue<Response>(
    new globalThis.Response(html, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
};

export default { ...worker, fetch };
