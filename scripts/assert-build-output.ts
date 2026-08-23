import { existsSync, readFileSync } from "node:fs";

const distDir = "dist";
const indexHtmlPath = `${distDir}/index.html`;
const workerPath = `${distDir}/index.js`;

for (const path of [indexHtmlPath, workerPath]) {
  if (!existsSync(path)) throw new Error(`Build output is missing: ${path}`);
}

const html = readFileSync(indexHtmlPath, "utf8");
if (!html.includes('src="/static/') || !html.includes('.js"')) {
  throw new Error("SSG HTML does not reference a client script");
}
if (!html.includes('href="/static/') || !html.includes('.css"')) {
  throw new Error("SSG HTML does not reference a stylesheet");
}
