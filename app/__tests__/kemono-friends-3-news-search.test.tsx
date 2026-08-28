// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "hono/jsx/dom/client";
import KemonoFriends3NewsSearch, {
  INITIAL_LOADING_INDICATOR_ID,
} from "../islands/KemonoFriends3NewsSearch";

const createNews = (
  id: number,
  title = `お知らせ${id}`,
  newsDate = `2026年08月${String(id).padStart(2, "0")}日 12時00分00秒`,
  category?: string,
) => ({
  targetUrl: `/info/${id}`,
  title,
  newsDate,
  updated: "",
  ...(category !== undefined ? { category } : {}),
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

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const mockNewsApi = ({
  news,
  headers = {
    "X-KF3-News-Source": "merged",
    "X-KF3-News-Official-Checked-At": new Date().toISOString(),
  },
  refreshResponses = [],
  getStatus = 200,
}: {
  news: unknown;
  headers?: HeadersInit;
  refreshResponses?: Response[];
  getStatus?: number;
}) => {
  let refreshIndex = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/kf3-news/refresh") && init?.method === "POST") {
        return (
          refreshResponses[refreshIndex++] ?? jsonResponse({ error: "no refresh response" }, 503)
        );
      }
      if (init?.method === "POST") throw new Error(`Unexpected POST request: ${url}`);
      return jsonResponse(news, getStatus, headers);
    }),
  );
};

const mount = () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<KemonoFriends3NewsSearch />);
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

const advanceRefreshCooldown = async (elapsedMs = 5 * 60_000) => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + elapsedMs);
  document.dispatchEvent(new Event("visibilitychange"));
  await flushUpdates();
};

const findButton = (label: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
};

const getRefreshButton = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="news-refresh-button"]');

const getRefreshIndicator = () =>
  container.querySelector<HTMLSpanElement>('[data-testid="news-metadata"]');

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
      createNews(index + 1, `お知らせ${index + 1}`, "2026年08月01日 12時00分00秒"),
    );
    mockNewsApi({ news });

    mount();
    await waitForText("･ 25件");
    expect(container.querySelectorAll("li")).toHaveLength(20);
    expect(intersectionObservers).toHaveLength(1);
    expect(intersectionObservers[0].observe).toHaveBeenCalledOnce();

    intersectionObservers[0].trigger();
    await vi.waitFor(() => expect(container.querySelectorAll("li")).toHaveLength(25));
    expect(intersectionObservers[0].disconnect).toHaveBeenCalledOnce();
  });

  it("Island外の初期スピナーをDOM置換せず取得完了後に非表示にする", async () => {
    const indicator = document.createElement("div");
    indicator.id = INITIAL_LOADING_INDICATOR_ID;
    const spinner = document.createElement("div");
    indicator.appendChild(spinner);
    document.body.appendChild(indicator);
    mockNewsApi({ news: [createNews(1)] });

    mount();
    await waitForText("･ 1件");

    expect(indicator.hidden).toBe(true);
    expect(indicator.firstElementChild).toBe(spinner);
  });

  it("検索時だけヒット件数を表示し、全件数は維持する", async () => {
    const news = Array.from({ length: 25 }, (_, index) =>
      createNews(index + 1, index < 3 ? `対象${index + 1}` : `別のお知らせ${index + 1}`),
    );
    mockNewsApi({ news });

    mount();
    await waitForText("･ 25件");
    expect(container.textContent).not.toContain("検索結果:");

    findButton("検索オプション").click();
    await flushUpdates();
    setInputValue(container.querySelector<HTMLInputElement>("#news-keyword")!, "対象");
    await flushUpdates();
    findButton("検索").click();

    await waitForText("検索結果: 3件");
    expect(container.textContent).toContain("･ 25件");
  });

  it("公式分類ラベルは値があるお知らせにだけ表示する", async () => {
    mockNewsApi({
      news: [
        createNews(
          1,
          "分類あり",
          "2026年08月01日 12時00分00秒",
          "イベント,キャンペーン,【サイト】アプリ",
        ),
        createNews(2, "分類なし"),
        createNews(3, "空の分類", "2026年08月03日 12時00分00秒", ""),
      ],
    });

    mount();
    await waitForText("･ 3件");

    const categories = container.querySelectorAll('[data-testid="news-category"]');
    expect(categories).toHaveLength(3);
    expect(Array.from(categories, (category) => category.textContent)).toEqual([
      "分類: イベント",
      "分類: キャンペーン",
      "分類: アプリ",
    ]);
    expect(new Set(Array.from(categories, (category) => category.className)).size).toBe(3);
  });

  it("公式確認日時とrefresh cooldownを別々に表示制御する", async () => {
    const officialCheckedAt = new Date(Date.now() - 2 * 60 * 1000 - 500).toISOString();
    const refreshAvailableAt = new Date(Date.now() + 3 * 60_000 - 500).toISOString();
    mockNewsApi({
      news: [createNews(1)],
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": officialCheckedAt,
        "X-KF3-News-Refresh-Available-At": refreshAvailableAt,
      },
    });

    mount();
    await waitForText("最終取得: 2分前");
    expect(container.textContent).toContain("最終取得: 2分前 ･ 1件");
    const refreshButton = getRefreshButton();
    const refreshIndicator = getRefreshIndicator();
    expect(refreshButton).not.toBeNull();
    expect(refreshIndicator).not.toBeNull();
    expect(refreshButton?.getAttribute("aria-label")).toBe("お知らせを再取得");
    expect(refreshIndicator?.getAttribute("aria-busy")).toBe("false");
    expect(refreshIndicator?.dataset.refreshStatus).toBe("cooldown");
    expect(refreshButton?.disabled).toBe(true);
    expect(refreshButton?.className).toContain("text-gray-400");
    expect(refreshButton?.className).not.toMatch(/bg-|border-/);
    expect(refreshIndicator?.querySelector("svg")?.getAttribute("class")).toContain(
      "text-green-600",
    );
    expect(refreshIndicator?.querySelector(`time[datetime="${officialCheckedAt}"]`)).not.toBeNull();
    expect(refreshButton?.querySelector("time")).toBeNull();

    await advanceRefreshCooldown(3 * 60_000);
    expect(refreshIndicator?.dataset.refreshStatus).toBe("idle");
    expect(refreshButton?.disabled).toBe(false);
    expect(refreshButton?.className).toContain("text-gray-700");
  });

  it("古いGETデータを表示してからrefreshを自動実行する", async () => {
    const oldNews = [createNews(1, "前回のお知らせ")];
    const refreshedNews = [createNews(1, "更新されたお知らせ")];
    const officialCheckedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const refreshedAt = new Date().toISOString();
    const refreshResponse = jsonResponse({
      news: refreshedNews,
      metadata: { source: "merged", officialCheckedAt: refreshedAt },
    });
    mockNewsApi({
      news: oldNews,
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": officialCheckedAt,
      },
      refreshResponses: [refreshResponse],
    });

    mount();
    await waitForText("前回のお知らせ");
    expect(container.querySelectorAll("li")).toHaveLength(1);
    await waitForText("更新されたお知らせ");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/kf3-news/refresh",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    await waitForText("最終取得:");
  });

  it("archive-snapshotを受け取った場合もrefreshする", async () => {
    const officialCheckedAt = new Date().toISOString();
    const refreshedAt = new Date().toISOString();
    mockNewsApi({
      news: [createNews(1, "スナップショット")],
      headers: {
        "X-KF3-News-Source": "archive-snapshot",
        "X-KF3-News-Official-Checked-At": officialCheckedAt,
      },
      refreshResponses: [
        jsonResponse({
          news: [createNews(1, "再取得済み")],
          metadata: { source: "merged", officialCheckedAt: refreshedAt },
        }),
      ],
    });

    mount();
    await waitForText("スナップショット");
    await waitForText("再取得済み");
  });

  it("data version一致時の変更なしrefreshは一覧を維持してmetadataだけ更新する", async () => {
    const dataVersion = "current-etag";
    const officialCheckedAt = new Date().toISOString();
    const refreshedAt = new Date(Date.now() + 1_000).toISOString();
    mockNewsApi({
      news: [createNews(1, "保持する一覧")],
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": officialCheckedAt,
        "X-KF3-News-Data-Version": dataVersion,
      },
      refreshResponses: [
        jsonResponse(
          {
            changed: false,
            metadata: { source: "merged", officialCheckedAt: refreshedAt },
          },
          200,
          {
            "X-KF3-News-Source": "merged",
            "X-KF3-News-Official-Checked-At": refreshedAt,
            "X-KF3-News-Data-Version": dataVersion,
          },
        ),
      ],
    });

    mount();
    await waitForText("保持する一覧");
    await advanceRefreshCooldown();
    getRefreshButton()?.click();
    await vi.waitFor(() => {
      expect(container.querySelector(`time[datetime="${refreshedAt}"]`)).not.toBeNull();
    });

    expect(container.textContent).toContain("保持する一覧");
    expect(container.textContent).not.toContain("更新された一覧");
    const refreshCall = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).endsWith("/api/kf3-news/refresh"));
    expect(refreshCall?.[1]).toEqual(
      expect.objectContaining({
        headers: { "X-KF3-News-Data-Version": dataVersion },
      }),
    );
    expect(getRefreshIndicator()?.dataset.refreshStatus).toBe("cooldown");
  });

  it("refreshの200がmerged以外なら前回一覧を維持する", async () => {
    mockNewsApi({
      news: [createNews(1, "前回一覧")],
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": new Date().toISOString(),
      },
      refreshResponses: [
        jsonResponse({
          news: [createNews(1, "不正な更新一覧")],
          metadata: { source: "archive-snapshot", officialCheckedAt: new Date().toISOString() },
        }),
      ],
    });

    mount();
    await waitForText("前回一覧");
    await advanceRefreshCooldown();
    getRefreshButton()?.click();
    await waitForText("再取得に失敗");
    expect(getRefreshIndicator()?.dataset.refreshStatus).toBe("error");
    expect(getRefreshButton()?.disabled).toBe(false);
    expect(getRefreshButton()?.className).toContain("text-gray-700");
    expect(getRefreshButton()?.className).not.toMatch(/bg-|border-/);
    expect(getRefreshIndicator()?.querySelector("svg")?.getAttribute("class")).toContain(
      "text-red-600",
    );
    expect(container.textContent).toContain("前回一覧");
    expect(container.textContent).not.toContain("不正な更新一覧");
  });

  it("refresh成功時も検索条件と表示件数を維持する", async () => {
    const oldNews = Array.from({ length: 25 }, (_, index) =>
      createNews(
        index + 1,
        `対象${index + 1}`,
        `2026年08月${String((index % 8) + 1).padStart(2, "0")}日 12時00分00秒`,
      ),
    );
    const refreshedNews = oldNews.map((news) => ({ ...news, title: `${news.title}更新` }));
    mockNewsApi({
      news: oldNews,
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": new Date().toISOString(),
      },
      refreshResponses: [
        jsonResponse({
          news: refreshedNews,
          metadata: { source: "merged", officialCheckedAt: new Date().toISOString() },
        }),
      ],
    });

    mount();
    await waitForText("･ 25件");
    findButton("検索オプション").click();
    await flushUpdates();
    const keyword = container.querySelector<HTMLInputElement>("#news-keyword");
    expect(keyword).not.toBeNull();
    setInputValue(keyword!, "対象");
    await flushUpdates();
    findButton("検索").click();
    await waitForText("検索結果: 25件");
    expect(container.textContent).toContain("･ 25件");
    intersectionObservers[0].trigger();
    await vi.waitFor(() => expect(container.querySelectorAll("li")).toHaveLength(25));

    await advanceRefreshCooldown();
    getRefreshButton()?.click();
    await waitForText("対象1更新");
    expect(container.querySelectorAll("li")).toHaveLength(25);
    expect((container.querySelector("#news-keyword") as HTMLInputElement).value).toBe("対象");
  });

  it("refresh成功時は公式確認日時とcooldown期限を別々に扱う", async () => {
    const baseTime = Date.parse("2026-08-27T12:00:00.000Z");
    const initialCheckedAt = new Date(baseTime).toISOString();
    const refreshCheckedAt = new Date(baseTime + 5 * 60_000 - 1_000).toISOString();
    const refreshAvailableAt = new Date(baseTime + 10 * 60_000).toISOString();
    vi.spyOn(Date, "now").mockReturnValue(baseTime);
    mockNewsApi({
      news: [createNews(1, "更新前")],
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": initialCheckedAt,
      },
      refreshResponses: [
        jsonResponse({
          news: [createNews(1, "更新後")],
          metadata: {
            source: "merged",
            officialCheckedAt: refreshCheckedAt,
            refreshAvailableAt,
          },
        }),
      ],
    });

    mount();
    await waitForText("更新前");
    await advanceRefreshCooldown();
    getRefreshButton()?.click();
    await waitForText("更新後");
    expect(container.querySelector(`time[datetime="${refreshCheckedAt}"]`)).not.toBeNull();

    await advanceRefreshCooldown(5 * 60_000 - 500);
    expect(getRefreshButton()?.disabled).toBe(true);
    await advanceRefreshCooldown(1_000);
    expect(getRefreshButton()?.disabled).toBe(false);
  });

  it("日付やソート変更では未送信のキーワードを適用しない", async () => {
    mockNewsApi({
      news: [createNews(1, "対象お知らせ"), createNews(2, "別お知らせ")],
    });

    mount();
    await waitForText("･ 2件");
    findButton("検索オプション").click();
    await flushUpdates();
    setInputValue(container.querySelector<HTMLInputElement>("#news-keyword")!, "対象");
    await flushUpdates();

    const startDate = container.querySelector<HTMLInputElement>("#startDate")!;
    setInputValue(startDate, "2019-09-25");
    await waitForText("･ 2件");

    const sortOrder = container.querySelector("#sortOrder") as unknown as HTMLSelectElement;
    sortOrder.value = "asc";
    sortOrder.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForText("･ 2件");
  });

  it("refreshの202をRetry-Afterで有限回再試行する", async () => {
    const officialCheckedAt = new Date().toISOString();
    mockNewsApi({
      news: [createNews(1, "再試行前")],
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": officialCheckedAt,
      },
      refreshResponses: [
        new Response(null, { status: 202, headers: { "Retry-After": "0.05" } }),
        jsonResponse({
          news: [createNews(1, "再試行後")],
          metadata: { source: "merged", officialCheckedAt: new Date().toISOString() },
        }),
      ],
    });

    mount();
    await waitForText("再試行前");
    await advanceRefreshCooldown();
    getRefreshButton()?.click();
    await flushUpdates();
    expect(getRefreshIndicator()?.dataset.refreshStatus).toBe("refreshing");
    expect(getRefreshButton()?.disabled).toBe(true);
    expect(getRefreshIndicator()?.querySelector(".animate-spin")).not.toBeNull();
    await waitForText("再試行後");
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/refresh")),
    ).toHaveLength(2);
  });

  it("refreshの二重開始を防止する", async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/kf3-news/refresh") && init?.method === "POST") {
        return refreshResponse;
      }
      if (init?.method === "POST") throw new Error(`Unexpected POST request: ${String(input)}`);
      return jsonResponse([createNews(1, "更新前")]);
    });
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await waitForText("更新前");
    const refreshButton = getRefreshButton();
    expect(refreshButton).not.toBeNull();
    await advanceRefreshCooldown();
    refreshButton?.click();
    refreshButton?.click();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/refresh")),
    ).toHaveLength(1);

    resolveRefresh?.(
      jsonResponse({
        news: [createNews(1, "更新後")],
        metadata: { source: "merged", officialCheckedAt: new Date().toISOString() },
      }),
    );
    await waitForText("更新後");
  });

  it("202の連続応答は上限回数で再試行を終了する", async () => {
    const officialCheckedAt = new Date().toISOString();
    mockNewsApi({
      news: [createNews(1, "再試行上限")],
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": officialCheckedAt,
      },
      refreshResponses: [
        new Response(null, { status: 202, headers: { "Retry-After": "0.01" } }),
        new Response(null, { status: 202, headers: { "Retry-After": "0.01" } }),
        new Response(null, { status: 202, headers: { "Retry-After": "0.01" } }),
      ],
    });

    mount();
    await waitForText("再試行上限");
    await advanceRefreshCooldown();
    getRefreshButton()?.click();
    await waitForText("再取得に失敗");
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/refresh")),
    ).toHaveLength(3);
  });

  it("自動refreshの待機中にunmountするとPOSTしない", async () => {
    const officialCheckedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/refresh")) {
        return jsonResponse({
          news: [createNews(1, "不要なrefresh")],
          metadata: { source: "merged", officialCheckedAt: new Date().toISOString() },
        });
      }
      return jsonResponse([createNews(1, "unmount対象")], 200, {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": officialCheckedAt,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await waitForText("unmount対象");
    root?.unmount();
    root = undefined;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/refresh")),
    ).toHaveLength(0);
  });

  it("refreshの503では前回一覧を維持して再試行可能にする", async () => {
    mockNewsApi({
      news: [createNews(1, "維持するお知らせ")],
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": new Date().toISOString(),
      },
      refreshResponses: [jsonResponse({ error: "failed" }, 503)],
    });

    mount();
    await waitForText("維持するお知らせ");
    await advanceRefreshCooldown();
    getRefreshButton()?.click();
    await waitForText("再取得に失敗");
    expect(container.textContent).toContain("維持するお知らせ");
    expect(getRefreshButton()?.disabled).toBe(false);
  });

  it("refreshの429では前回一覧を維持する", async () => {
    const officialCheckedAt = new Date().toISOString();
    mockNewsApi({
      news: [createNews(1, "維持するお知らせ")],
      headers: {
        "X-KF3-News-Source": "merged",
        "X-KF3-News-Official-Checked-At": officialCheckedAt,
      },
      refreshResponses: [
        new Response(JSON.stringify({ cooldownSeconds: 30 }), {
          status: 429,
          headers: { "content-type": "application/json", "Retry-After": "30" },
        }),
      ],
    });

    mount();
    await waitForText("維持するお知らせ");
    await advanceRefreshCooldown();
    getRefreshButton()?.click();
    await waitForText("お知らせは再取得待機中です");
    expect(getRefreshIndicator()?.dataset.refreshStatus).toBe("cooldown");
    expect(getRefreshButton()?.disabled).toBe(true);
    expect(getRefreshIndicator()?.querySelector("svg")?.getAttribute("class")).toContain(
      "text-green-600",
    );
    expect(getRefreshIndicator()?.querySelector("svg")?.getAttribute("class")).not.toContain(
      "text-red-600",
    );
    expect(container.textContent).not.toContain("再取得はあと");
    expect(container.textContent).not.toContain("秒後");
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("検索トグルとキーワード入力をアクセシブルに接続する", async () => {
    mockNewsApi({ news: [createNews(1)] });
    mount();
    await waitForText("･ 1件");

    const toggle = findButton("検索オプション");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("news-search-options");
    toggle.click();
    await flushUpdates();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('label[for="news-keyword"]')).not.toBeNull();
    expect(container.querySelector('label[for="startDate"]')?.className).toBe("sr-only");
    expect(container.querySelector('label[for="endDate"]')?.className).toBe("sr-only");
  });

  it.each([
    {
      name: "HTTP error",
      setup: () => mockNewsApi({ news: { error: "failed" }, getStatus: 503 }),
    },
    {
      name: "schema error",
      setup: () => mockNewsApi({ news: { news: [] } }),
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
    const indicator = document.createElement("div");
    indicator.id = INITIAL_LOADING_INDICATOR_ID;
    document.body.appendChild(indicator);
    setup();
    mount();

    await waitForText("データの取得に失敗しました。");
    expect(indicator.hidden).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});
