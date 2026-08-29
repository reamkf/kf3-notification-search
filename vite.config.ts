import honox from "honox/vite";
import { defineConfig } from "vite";
import adapter from "@hono/vite-dev-server/cloudflare";
import build, {
  defaultOptions as cloudflareWorkersBuildOptions,
} from "@hono/vite-build/cloudflare-workers";

export default defineConfig(({ command }) => ({
  server: {
    host: true,
    allowedHosts: true,
  },
  plugins: [
    honox({
      entry: command === "serve" ? "./app/dev-server.ts" : "./app/worker.ts",
      client: {
        input: ["/app/client.ts", "/app/style.css"],
      },
      devServer: {
        adapter,
        handleHotUpdate({ server, modules }) {
          if (!modules.some((module) => module.ssrModule)) return;
          server.hot.send({ type: "full-reload" });
          return [];
        },
      },
    }),
    build({
      external: ["cloudflare:workers"],
      entryContentAfterHooks: [
        ...cloudflareWorkersBuildOptions.entryContentAfterHooks,
        () => 'export { NewsRefreshCoordinator } from "/app/news-refresh-coordinator.ts";',
      ],
    }),
  ],
  ssr: {
    external: ["dayjs", "cloudflare:workers"],
  },
}));
