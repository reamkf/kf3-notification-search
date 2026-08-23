import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:8787";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/static-assets-preview.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "bun run build && bunx wrangler dev --ip 127.0.0.1 --port 8787",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SITE_ORIGIN: baseURL,
    },
  },
});
