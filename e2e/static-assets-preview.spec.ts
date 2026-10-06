import { expect, test } from "@playwright/test";

test("robotsとホーム画面アイコンをStatic Assetsから返す", async ({ request }) => {
  const robotsResponse = await request.get("/robots.txt");
  expect(robotsResponse.status()).toBe(200);
  expect(robotsResponse.headers()["content-type"]).toContain("text/plain");
  expect(await robotsResponse.text()).toBe("User-agent: *\nDisallow:\n");

  for (const path of [
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/apple-touch-icon-160x160.png",
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
    const png = await response.body();
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(256);
    expect(png.readUInt32BE(20)).toBe(256);
  }
});

test("SSG shellをStatic Assetsから返し、APIをWorkerへfallbackする", async ({ page, request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const html = await response.text();

  const fontStylesheetPath = html.match(/href="(\/static\/font-[^"]+\.css)"/)?.[1];
  expect(fontStylesheetPath).toBeDefined();
  const fontStylesheetResponse = await request.get(fontStylesheetPath!);
  expect(fontStylesheetResponse.status()).toBe(200);
  expect(fontStylesheetResponse.headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );

  const fontPath = (await fontStylesheetResponse.text()).match(
    /url\(["']?(\/static\/noto-sans-jp-[^)"']+\.woff2)/,
  )?.[1];
  expect(fontPath).toBeDefined();
  const fontResponse = await request.get(fontPath!);
  expect(fontResponse.status()).toBe(200);
  expect(fontResponse.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");

  let newsRequests = 0;
  let preHydrationNewsRequests = 0;
  await page.route("**/api/kf3-news", async (route) => {
    newsRequests += 1;
    const isHydrated = await page.evaluate(
      () => document.querySelector("honox-island")?.hasAttribute("data-hono-hydrated") ?? false,
    );
    if (!isHydrated) preHydrationNewsRequests += 1;
    await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("honox-island")).toBeAttached();
  await expect(page.locator("#initial-loading-indicator")).toBeHidden();
  expect(newsRequests).toBe(1);
  expect(preHydrationNewsRequests).toBe(1);

  const refreshResponse = await request.post("/api/kf3-news/refresh");
  expect([200, 202, 429, 503]).toContain(refreshResponse.status());
});
