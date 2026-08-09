import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const bucket = "kf3-notif-data";
const archiveKeys = ["archive/current.json", "entries_merged_20241107.json"];
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

const isNewsDocument = (value) =>
  value !== null && typeof value === "object" && Array.isArray(value.news);

const findProductionData = async (temporaryFile) => {
  for (const key of archiveKeys) {
    const result = await runWrangler([
      "r2",
      "object",
      "get",
      `${bucket}/${key}`,
      "--remote",
      "--file",
      temporaryFile,
    ]);
    if (result.code !== 0) continue;

    try {
      const value = JSON.parse(await readFile(temporaryFile, "utf8"));
      if (isNewsDocument(value)) return key;
    } catch {
      // Try the legacy object when the current object is invalid.
    }
  }
  return null;
};

const main = async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kf3-notification-search-"));
  const temporaryFile = join(temporaryDirectory, "production-data.json");
  try {
    const sourceKey = await findProductionData(temporaryFile);
    if (sourceKey === null) {
      console.warn("本番R2の初期データを取得できないため、ダミーデータを使用します");
      return;
    }

    for (const key of archiveKeys) {
      const result = await runWrangler([
        "r2",
        "object",
        "put",
        `${bucket}/${key}`,
        "--local",
        ...localPersistenceArgs,
        "--file",
        temporaryFile,
        "--content-type",
        "application/json",
        "--force",
      ]);
      if (result.code !== 0) {
        throw new Error(`本番データのローカルR2への投入に失敗しました: ${result.stderr.trim()}`);
      }
    }
    console.log(`本番R2の${sourceKey}をローカルR2へ投入しました`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
