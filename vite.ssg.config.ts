import ssg from "@hono/vite-ssg";
import honox from "honox/vite";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
  },
  plugins: [honox(), ssg({ entry: "./app/ssg.ts" })],
  ssr: {
    external: ["dayjs"],
  },
});
