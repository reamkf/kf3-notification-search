import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRenderer } from "../routes/_renderer";

describe("renderer metadata", () => {
  it("uses an absolute URL for the social image metadata", async () => {
    const app = new Hono();
    const renderer = createRenderer({ Link: () => null, Script: () => null });
    app.use("*", renderer);
    app.get("/", (c) => c.render("content", { title: "けもフレ３おしらせ検索" }));

    const response = await app.request("https://example.com/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<meta property="og:image" content="https://example.com/og-image.jpg"');
    expect(html).toContain('<meta name="twitter:image" content="https://example.com/og-image.jpg"');
  });
});
