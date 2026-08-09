// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "hono/jsx/dom/client";
import KemonoFriends3NewsSearch from "../islands/KemonoFriends3NewsSearch";

const createNews = (
  id: number,
  title = `ニュース${id}`,
  newsDate = `2026年08月${String(id).padStart(2, "0")}日 12時00分00秒`,
) => ({
  targetUrl: `/info/${id}`,
  title,
  newsDate,
  updated: "",
});

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  readonly takeRecords = vi.fn(() => []);

  constructor(private readonly callback: IntersectionObserverCallback) {
    intersectionObservers.push(this);
  }

  trigger(isIntersecting = true) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const intersectionObservers: TestIntersectionObserver[] = [];
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

const mount = () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<KemonoFriends3NewsSearch />);
};

const mockNewsResponse = (news: unknown, status = 200) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(news), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
};

const waitForText = (text: string) =>
  vi.waitFor(() => {
    expect(container.textContent).toContain(text);
  });

const setInputValue = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const flushUpdates = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const findButton = (label: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
};

beforeEach(() => {
  intersectionObservers.length = 0;
  localStorage.clear();
  vi.stubGlobal(
    "IntersectionObserver",
    TestIntersectionObserver as unknown as typeof IntersectionObserver,
  );
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("KemonoFriends3NewsSearch", () => {
  it("取得中から成功へ遷移し、20件ずつ追加表示する", async () => {
    const news = Array.from({ length: 25 }, (_, index) =>
      createNews(index + 1, `ニュース${index + 1}`, "2026年08月01日 12時00分00秒"),
    );
    mockNewsResponse(news);

    mount();
    expect(container.textContent).toContain("データを取得しています...");
    await waitForText("おしらせの件数: 25件");
    expect(container.querySelectorAll("li")).toHaveLength(20);
    expect(intersectionObservers).toHaveLength(1);
    expect(intersectionObservers[0].observe).toHaveBeenCalledOnce();

    intersectionObservers[0].trigger();
    await vi.waitFor(() => expect(container.querySelectorAll("li")).toHaveLength(25));
    expect(intersectionObservers[0].disconnect).toHaveBeenCalledOnce();
  });

  it("keyword、日付、sort順を画面操作から適用する", async () => {
    mockNewsResponse([
      createNews(1, "測定イベント", "2026年08月01日 12時00分00秒"),
      createNews(2, "掃除イベント", "2026年08月02日 12時00分00秒"),
      createNews(3, "開催予告", "2026年08月03日 12時00分00秒"),
    ]);
    mount();
    await waitForText("おしらせの件数: 3件");

    const keyword = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(keyword).not.toBeNull();
    setInputValue(keyword!, "測定 OR 掃除");
    await flushUpdates();
    findButton("検索").click();
    await waitForText("おしらせの件数: 2件");

    const sortOrder = container.querySelector("#sortOrder") as unknown as HTMLSelectElement | null;
    expect(sortOrder).not.toBeNull();
    sortOrder!.value = "asc";
    sortOrder!.dispatchEvent(new Event("input", { bubbles: true }));
    sortOrder!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushUpdates();
    await vi.waitFor(() => {
      expect(container.querySelector("li p")?.textContent).toBe("測定イベント");
    });

    setInputValue(keyword!, "");
    await flushUpdates();
    findButton("検索").click();
    const startDate = container.querySelector<HTMLInputElement>("#startDate");
    const endDate = container.querySelector<HTMLInputElement>("#endDate");
    expect(startDate).not.toBeNull();
    expect(endDate).not.toBeNull();
    setInputValue(startDate!, "2026-08-02");
    await flushUpdates();
    setInputValue(endDate!, "2026-08-02");
    await waitForText("おしらせの件数: 1件");
    expect(container.querySelector("li p")?.textContent).toBe("掃除イベント");
  });

  it("検索欄の表示状態を保存し、IME変換中のEnterを無視する", async () => {
    localStorage.setItem("kf3notif:isSearchVisible", "true");
    mockNewsResponse([
      createNews(1, "測定イベント", "2026年08月01日 12時00分00秒"),
      createNews(2, "掃除イベント", "2026年08月02日 12時00分00秒"),
    ]);
    mount();
    await waitForText("おしらせの件数: 2件");

    const searchPanel = container.querySelector(".max-h-screen");
    expect(searchPanel).not.toBeNull();
    findButton("検索オプション").click();
    expect(localStorage.getItem("kf3notif:isSearchVisible")).toBe("false");

    const keyword = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(keyword).not.toBeNull();
    setInputValue(keyword!, "測定");
    await flushUpdates();
    keyword!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(container.textContent).toContain("おしらせの件数: 2件");

    keyword!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitForText("おしらせの件数: 1件");
  });

  it.each([
    {
      name: "HTTP error",
      setup: () => mockNewsResponse({ error: "failed" }, 503),
    },
    {
      name: "schema error",
      setup: () => mockNewsResponse({ news: [] }),
    },
    {
      name: "network error",
      setup: () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => Promise.reject(new Error("network failed"))),
        );
      },
    },
  ])("$nameを利用者向けerror表示へ変換する", async ({ setup }) => {
    setup();
    mount();

    await waitForText("データの取得に失敗しました。");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
