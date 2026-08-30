import { describe, expect, it, vi } from "vitest";
import notFoundHandler from "../routes/_404";
import { bridgeRuntimeValue } from "../runtime-value";
import errorHandler from "../routes/_error";

const createNotFoundContext = (
  method: string,
  assetResponse: Response,
  assetFetch = vi.fn(async () => assetResponse),
) => {
  const status = vi.fn();
  const renderedResponse = new Response("404 Not Found", { status: 404 });
  const render = vi.fn(() => renderedResponse);
  const request = new Request("https://example.com/missing", {
    method,
    redirect: "manual",
    headers: { accept: "text/html" },
  });
  const context = bridgeRuntimeValue<Parameters<typeof notFoundHandler>[0]>({
    req: { method, raw: request, url: request.url, header: () => ({}) },
    env: { ASSETS: { fetch: assetFetch } },
    status,
    render,
  });
  return { context, request, status, render, assetFetch, renderedResponse };
};

describe("404 handler", () => {
  it.each(["GET", "HEAD"])("%sのstatic asset responseを返す", async (method) => {
    const assetResponse = new Response(method === "GET" ? "asset" : null, { status: 200 });
    const setup = createNotFoundContext(method, assetResponse);

    expect(await notFoundHandler(setup.context)).toBe(assetResponse);
    expect(setup.assetFetch).toHaveBeenCalledOnce();
    expect(setup.assetFetch).toHaveBeenCalledWith(setup.request);
    expect(setup.request.method).toBe(method);
    expect(setup.request.redirect).toBe("manual");
    expect(setup.request.headers.get("accept")).toBe("text/html");
    expect(setup.status).not.toHaveBeenCalled();
  });

  it("assetも404ならappの404 responseを返す", async () => {
    const setup = createNotFoundContext("GET", new Response(null, { status: 404 }));

    expect(await notFoundHandler(setup.context)).toBe(setup.renderedResponse);
    expect(setup.status).toHaveBeenCalledWith(404);
    expect(setup.render).toHaveBeenCalledWith("404 Not Found");
  });

  it("GETとHEAD以外ではasset bindingを呼ばない", async () => {
    const setup = createNotFoundContext("POST", new Response("asset"));

    expect(await notFoundHandler(setup.context)).toBe(setup.renderedResponse);
    expect(setup.assetFetch).not.toHaveBeenCalled();
    expect(setup.status).toHaveBeenCalledWith(404);
  });
});

describe("error handler", () => {
  it("getResponseを持つerrorのresponseを維持する", () => {
    const expected = new Response("bad request", { status: 400 });
    const error = Object.assign(new Error("bad request"), { getResponse: () => expected });
    const context = bridgeRuntimeValue<Parameters<typeof errorHandler>[1]>({});

    expect(errorHandler(error, context)).toBe(expected);
  });

  it("通常errorを500としてrenderする", () => {
    const status = vi.fn();
    const expected = new Response("Internal Server Error", { status: 500 });
    const render = vi.fn(() => expected);
    const context = bridgeRuntimeValue<Parameters<typeof errorHandler>[1]>({ status, render });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(errorHandler(new Error("failed"), context)).toBe(expected);
      expect(status).toHaveBeenCalledWith(500);
      expect(render).toHaveBeenCalledWith("Internal Server Error");
      expect(consoleError).toHaveBeenCalledWith("failed");
    } finally {
      consoleError.mockRestore();
    }
  });
});
