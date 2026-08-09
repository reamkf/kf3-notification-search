import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const localBucket = "kf3-notif-data";
const localKeys = ["archive/current.json", "entries_merged_20241107.json"];
const dummyDocument = {
  news: [
    {
      id: 1,
      targetUrl: "/info/detail/development.html",
      title: "開発用のお知らせ",
      newsDate: "2026年01月01日 00時00分00秒",
      updated: "",
    },
  ],
};
const localPersistenceArgs = process.env.WRANGLER_PERSIST_TO
  ? ["--persist-to", process.env.WRANGLER_PERSIST_TO]
  : [];

const runWrangler = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["x", "wrangler", ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });

const main = async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kf3-notification-search-"));
  const temporaryFile = join(temporaryDirectory, "initial-data.json");
  try {
    await writeFile(temporaryFile, JSON.stringify(dummyDocument), "utf8");
    for (const key of localKeys) {
      const result = await runWrangler([
        "r2",
        "object",
        "put",
        `${localBucket}/${key}`,
        "--local",
        ...localPersistenceArgs,
        "--file",
        temporaryFile,
        "--content-type",
        "application/json",
        "--force",
      ]);
      if (result.code !== 0) {
        throw new Error(`ローカルR2へのダミーデータ投入に失敗しました: ${result.stderr.trim()}`);
      }
    }
    console.log("ローカルR2へダミーデータを投入しました");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
