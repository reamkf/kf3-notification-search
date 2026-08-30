import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import tailwindcss from "@tailwindcss/vite";
import ssg from "@hono/vite-ssg";
import honox from "honox/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import build, {
  defaultOptions as cloudflareWorkersBuildOptions,
} from "@hono/vite-build/cloudflare-workers";

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

const tooling = {
  lint: {
    plugins: ["typescript", "unicorn", "oxc"],
    categories: {
      correctness: "error",
    },
    env: {
      builtin: true,
    },
  },
  fmt: {
    ignorePatterns: [],
  },
  staged: {
    "*.{js,jsx,ts,tsx,mts,cts}": "vp check --fix",
  },
};

export default defineConfig(({ command, mode }) => {
  if (mode === "test") {
    return {
      ...tooling,
      test: {
        reporters: ["verbose"],
        projects: [
          {
            test: {
              name: "unit",
              include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
              exclude: ["**/*.worker.test.ts", "**/e2e/**", "**/node_modules/**", "**/dist/**"],
              environment: "node",
            },
          },
          {
            plugins: [
              cloudflareTest({
                wrangler: { configPath: "./wrangler.test.toml" },
              }),
            ],
            test: {
              name: "worker",
              include: ["app/**/*.worker.test.ts"],
            },
          },
        ],
      },
    };
  }

  if (command === "serve" && mode === "development") {
    return {
      ...tooling,
      server: {
        host: true,
        allowedHosts: true,
      },
      plugins: lazyPlugins(() => [
        tailwindcss(),
        ...cloudflare({
          config: { main: "./app/dev-server.ts" },
        }),
        cloudflareDevOptimizeDeps,
        honox({
          entry: "./app/dev-server.ts",
          client: {
            input: ["/app/client.ts", "/app/style.css", "/app/font.css"],
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
      ]),
      ssr: {
        external: ["dayjs", "cloudflare:workers"],
      },
    };
  }

  if (mode === "ssg") {
    return {
      ...tooling,
      build: {
        emptyOutDir: false,
      },
      plugins: lazyPlugins(() => [tailwindcss(), honox(), ssg({ entry: "./app/ssg.ts" })]),
      ssr: {
        external: ["dayjs"],
      },
    };
  }

  return {
    ...tooling,
    server: {
      host: true,
      allowedHosts: true,
    },
    plugins: lazyPlugins(() => [
      tailwindcss(),
      honox({
        entry: "./app/worker.ts",
        client: {
          input: ["/app/client.ts", "/app/style.css", "/app/font.css"],
        },
        devServer: {
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
          ...(cloudflareWorkersBuildOptions.entryContentAfterHooks ?? []),
          () => 'export { NewsRefreshCoordinator } from "/app/news-refresh-coordinator.ts";',
        ],
      }),
    ]),
    ssr: {
      external: ["dayjs", "cloudflare:workers"],
    },
  };
});
