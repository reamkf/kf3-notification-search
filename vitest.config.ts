import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    exclude: ["**/*.worker.test.ts", "**/e2e/**", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    reporters: ["verbose"],
  },
});
