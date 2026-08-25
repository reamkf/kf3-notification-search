import { existsSync, readFileSync } from "node:fs";

const distDir = "dist";
const indexHtmlPath = `${distDir}/index.html`;
const workerPath = `${distDir}/index.js`;
const siteOrigin = process.env.VITE_SITE_ORIGIN;

if (!siteOrigin) throw new Error("VITE_SITE_ORIGIN is required for the SSG build");

let expectedOgImageUrl: string;
try {
  const origin = new URL(siteOrigin);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("unsupported protocol");
  }
  expectedOgImageUrl = new URL("/og-image.jpg", origin).href;
} catch {
  throw new Error("VITE_SITE_ORIGIN must be an absolute HTTP(S) URL");
}

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
if (
  !html.includes('rel="preload"') ||
  !html.includes('href="/api/kf3-news"') ||
  !html.includes('as="fetch"')
) {
  throw new Error("SSG HTML does not preload the news API");
}
if (
  !html.includes(`<meta property="og:image" content="${expectedOgImageUrl}"`) ||
  !html.includes(`<meta name="twitter:image" content="${expectedOgImageUrl}"`)
) {
  throw new Error("SSG HTML does not use VITE_SITE_ORIGIN for OGP image URLs");
}
