import honox from "honox/vite";
import { defaultOptions as devServerDefaultOptions } from "@hono/vite-dev-server";
import { defineConfig } from "vite";
import adapter from "@hono/vite-dev-server/cloudflare";
import build from "@hono/vite-build/cloudflare-workers";

export default defineConfig({
  server: {
    host: true,
    allowedHosts: true,
  },
  plugins: [
    honox({
      client: {
        input: ["/app/client.ts", "/app/style.css"],
      },
      devServer: {
        adapter,
        handleHotUpdate: devServerDefaultOptions.handleHotUpdate,
      },
    }),
    build(),
  ],
  ssr: {
    external: ["dayjs"],
  },
});
