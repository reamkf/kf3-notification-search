import { expect, test } from "@playwright/test";

test("SSG shellをStatic Assetsから返し、APIをWorkerへfallbackする", async ({ page, request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const html = await response.text();

  expect(html).toContain("<honox-island");
  expect(html).toMatch(/src="\/static\/[^"]+\.js"/);
  expect(html).toMatch(/href="\/static\/[^"]+\.css"/);
  expect(html).toContain('<meta property="og:image" content="http://127.0.0.1:8787/og-image.jpg"');

  await page.goto("/");
  await expect(page.locator("honox-island")).toBeAttached();

  const refreshResponse = await request.post("/api/kf3-news/refresh");
  expect([200, 202, 429, 503]).toContain(refreshResponse.status());
});
