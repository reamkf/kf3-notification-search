import { cloudflare } from "@cloudflare/vite-plugin";
import honox from "honox/vite";
import { defineConfig } from "vite";

const cloudflareDevOptimizeDeps = {
  name: "kf3notif-cloudflare-vite-optimize",
  config: () => ({
    environments: {
      kf3notif: {
        optimizeDeps: {
          include: [
            "dayjs",
            "dayjs/locale/ja",
            "dayjs/plugin/timezone",
            "dayjs/plugin/utc",
            "hono",
            "hono/jsx",
            "hono/jsx-renderer",
            "hono/jsx/jsx-dev-runtime",
            "honox/factory",
            "honox/server",
            "honox/vite/components",
            "valibot",
          ],
        },
      },
    },
  }),
};

export default defineConfig({
  server: {
    host: true,
    allowedHosts: true,
  },
  plugins: [
    ...cloudflare({
      config: { main: "./app/dev-server.ts" },
    }),
    cloudflareDevOptimizeDeps,
    honox({
      entry: "./app/dev-server.ts",
      client: {
        input: ["/app/client.ts", "/app/style.css"],
      },
      devServer: {
        exclude: [/^\/.*/],
        handleHotUpdate({ server, file }) {
          const normalizedFile = file.replaceAll("\\\\", "/");
          if (!normalizedFile.includes("/app/") || normalizedFile.endsWith(".css")) return;
          server.hot.send({ type: "full-reload" });
          return [];
        },
      },
    }),
  ],
  ssr: {
    external: ["dayjs", "cloudflare:workers"],
  },
});
