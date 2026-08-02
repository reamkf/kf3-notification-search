import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import renderer from "../routes/_renderer";

vi.mock("honox/server", () => ({
  Link: () => null,
  Script: () => null,
}));

describe("renderer metadata", () => {
  it("uses an absolute URL for the social image metadata", async () => {
    const app = new Hono();
    app.use("*", renderer);
    app.get("/", (c) => c.render("content", { title: "けもフレ３おしらせ検索" }));

    const response = await app.request("https://example.com/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<meta property="og:image" content="https://example.com/og-image.jpg"');
    expect(html).toContain('<meta name="twitter:image" content="https://example.com/og-image.jpg"');
  });
});
