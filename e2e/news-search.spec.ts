import { expect, test, type Page } from "@playwright/test";

const news = [
  {
    targetUrl: "/info/1",
    title: "測定イベント開催のお知らせ",
    newsDate: "2026年08月01日 12時00分00秒",
    updated: "",
    category: "イベント,キャンペーン,【サイト】アプリ",
  },
  {
    targetUrl: "/info/2",
    title: "掃除イベント開催のお知らせ",
    newsDate: "2026年08月02日 12時00分00秒",
    updated: "",
  },
  {
    targetUrl: "/info/3",
    title: "新イベント開催予告",
    newsDate: "2026年08月03日 12時00分00秒",
    updated: "",
  },
];

const refreshNews = [
  { ...news[0], title: "測定イベント更新のお知らせ" },
  { ...news[1], title: "掃除イベント更新のお知らせ" },
  { ...news[2], title: "新イベント更新予告" },
];

const mockNewsApi = async (
  page: Page,
  options: {
    source?: string;
    officialCheckedAt?: string;
    refreshBody?: unknown;
    refreshStatus?: number;
    refreshHeaders?: Record<string, string>;
    refreshDelayMs?: number;
  } = {},
) => {
  await page.route("**/api/kf3-news", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "X-KF3-News-Source": options.source ?? "merged",
        "X-KF3-News-Official-Checked-At": options.officialCheckedAt ?? new Date().toISOString(),
      },
      body: JSON.stringify(news),
    });
  });
  await page.route("**/api/kf3-news/refresh", async (route) => {
    expect(route.request().method()).toBe("POST");
    if (options.refreshDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.refreshDelayMs));
    }
    return route.fulfill({
      status: options.refreshStatus ?? 200,
      contentType: "application/json",
      headers: options.refreshHeaders,
      body: JSON.stringify(
        options.refreshBody ?? {
          news: refreshNews,
          metadata: { source: "merged", officialCheckedAt: new Date().toISOString() },
        },
      ),
    });
  });
};

const openNewsSearch = async (page: Page, options = {}) => {
  await mockNewsApi(page, options);
  await page.goto("/");
  await expect(page.getByTestId("news-metadata").getByText("3件")).toBeVisible();
};

test("お知らせ一覧を新しい順に表示し、公式サイトへのリンクを生成する", async ({ page }) => {
  await openNewsSearch(page);
  const items = page.locator("ul > li");

  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText("新イベント開催予告");
  await expect(items.first().getByRole("link")).toHaveAttribute(
    "href",
    "https://kemono-friends-3.jp/info/3",
  );
});

test("公式分類ラベルを値があるお知らせにだけ表示する", async ({ page }) => {
  await openNewsSearch(page);

  const categories = page.getByTestId("news-category");
  await expect(categories).toHaveCount(3);
  await expect(categories.nth(0)).toHaveText("分類: イベント");
  await expect(categories.nth(1)).toHaveText("分類: キャンペーン");
  await expect(categories.nth(2)).toHaveText("分類: アプリ");
  const categoryClasses = await categories.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("class")),
  );
  expect(new Set(categoryClasses).size).toBe(3);
  const items = page.locator("ul > li");
  await expect(items.filter({ has: categories })).toHaveCount(1);
  await expect(items.filter({ hasNot: categories })).toHaveCount(2);
});

test("公式確認日時を相対表示し、GET後は再取得できる", async ({ page }) => {
  await page.clock.install();
  await openNewsSearch(page, { refreshDelayMs: 200 });

  const metadata = page.getByTestId("news-metadata");
  const reloadButton = page.getByTestId("news-refresh-button");
  await expect(metadata.getByText(/最終取得:/)).toBeVisible();
  await expect(reloadButton).toHaveAttribute("aria-label", "お知らせを再取得");
  await expect(metadata).toHaveAttribute("aria-busy", "false");
  await expect(metadata).toHaveAttribute("data-refresh-status", "idle");
  await expect(reloadButton).toBeEnabled();
  await expect(reloadButton).toHaveClass(/text-gray-700/);
  await expect(reloadButton).not.toHaveClass(/bg-|border-/);
  await expect(metadata.locator("svg")).toHaveClass(/text-green-600/);
  await expect(reloadButton.locator("time")).toHaveCount(0);

  const refreshRequest = page.waitForRequest("**/api/kf3-news/refresh");
  await reloadButton.click();
  await refreshRequest;
  await expect(metadata).toHaveAttribute("data-refresh-status", "refreshing");
  await expect(reloadButton).toBeDisabled();
  await expect(metadata.locator(".animate-spin")).toBeVisible();
  await expect(page.getByText("測定イベント更新のお知らせ")).toBeVisible();
  await expect(metadata).toHaveAttribute("data-refresh-status", "cooldown");
  await expect(reloadButton).toBeDisabled();
  await expect(reloadButton).toHaveClass(/text-gray-400/);
  await expect(reloadButton).not.toHaveClass(/bg-|border-/);
  await expect(metadata.locator("svg")).toHaveClass(/text-green-600/);
});

test("古いGETデータを表示後に自動再取得する", async ({ page }) => {
  await openNewsSearch(page, {
    officialCheckedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    refreshDelayMs: 200,
  });
  await expect(page.getByText("測定イベント開催のお知らせ")).toBeVisible();
  await expect(page.getByText("測定イベント更新のお知らせ")).toBeVisible();
});

test("閉じた検索パネルのcontrolsはfocus対象から外れる", async ({ page }) => {
  await openNewsSearch(page);
  const panel = page.locator("#news-search-options");
  await expect(panel).toHaveAttribute("aria-hidden", "true");
  await expect(panel.locator("input, select, button")).toHaveCount(0);
  await page.getByRole("button", { name: "検索オプション" }).click();
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect(panel.locator("input, select, button")).not.toHaveCount(0);
});

test("archive-fallback表示後に自動再取得する", async ({ page }) => {
  await openNewsSearch(page, {
    source: "archive-fallback",
    officialCheckedAt: new Date().toISOString(),
    refreshDelayMs: 200,
  });

  await expect(
    page.getByText("公式データを利用できなかったため、保存済みアーカイブを表示しています。"),
  ).toBeVisible();
  await expect(page.getByText("測定イベント更新のお知らせ")).toBeVisible();
});

test("archive-snapshot表示後に自動再取得する", async ({ page }) => {
  await openNewsSearch(page, {
    source: "archive-snapshot",
    officialCheckedAt: new Date().toISOString(),
  });

  await expect(page.getByText("測定イベント更新のお知らせ")).toBeVisible();
});

test("キーワード、並び順、期間でお知らせを絞り込む", async ({ page }) => {
  await openNewsSearch(page);
  await page.getByRole("button", { name: "検索オプション" }).click();
  await page.getByLabel("キーワード検索:").fill("測定 OR 掃除");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByText("検索結果: 2件")).toBeVisible();

  await page.getByLabel("ソート順:").selectOption("asc");
  await expect(page.locator("li").first()).toContainText("測定イベント");

  await page.getByLabel("開始日").fill("2026-08-02");
  await page.getByLabel("終了日").fill("2026-08-02");
  await expect(page.getByText("検索結果: 1件")).toBeVisible();
  await expect(page.locator("li")).toContainText("掃除イベント");
});

test("検索オプションの表示状態を再読み込み後も保持する", async ({ page }) => {
  await openNewsSearch(page);
  const optionsButton = page.getByRole("button", { name: "検索オプション" });

  await expect(optionsButton).toHaveAttribute("aria-expanded", "false");
  await optionsButton.click();
  await expect(optionsButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#news-search-options")).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("news-metadata").getByText("3件")).toBeVisible();
  await expect(page.getByRole("button", { name: "検索オプション" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

test("APIエラー時にエラーを表示し、お知らせ一覧を表示しない", async ({ page }) => {
  await page.route("**/api/kf3-news", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "failed" }),
    }),
  );

  await page.goto("/");

  await expect(page.getByRole("alert")).toContainText("データの取得に失敗しました。");
  await expect(page.getByText("データを取得しています...")).toBeHidden();
  await expect(page.locator("ul > li")).toHaveCount(0);
});

test("refreshの429では前回一覧を維持し、再取得後にcooldownを表示する", async ({ page }) => {
  await page.clock.install();
  await openNewsSearch(page, {
    officialCheckedAt: new Date().toISOString(),
    refreshStatus: 429,
    refreshBody: { cooldownSeconds: 30 },
    refreshHeaders: { "Retry-After": "30" },
  });

  const metadata = page.getByTestId("news-metadata");
  const reloadButton = page.getByTestId("news-refresh-button");
  await expect(reloadButton).toBeEnabled();
  await reloadButton.click();
  await expect(metadata).toHaveAttribute("data-refresh-status", "cooldown");
  await expect(reloadButton).toHaveClass(/text-gray-400/);
  await expect(reloadButton).not.toHaveClass(/bg-|border-/);
  await expect(metadata.locator("svg")).toHaveClass(/text-green-600/);
  await expect(reloadButton).toBeDisabled();
  await expect(page.getByText("お知らせは再取得待機中です")).toBeAttached();
  await expect(page.getByText(/再取得はあと|秒後/)).toHaveCount(0);
  await expect(page.locator("ul > li")).toHaveCount(3);
});

test("20件を超えるお知らせをスクロールに応じて追加表示する", async ({ page }) => {
  const manyNews = Array.from({ length: 25 }, (_, index) => ({
    targetUrl: `/info/${index + 1}`,
    title: `お知らせ${index + 1}`,
    newsDate: `2026年08月${String((index % 8) + 1).padStart(2, "0")}日 12時00分00秒`,
    updated: "",
  }));
  await page.route("**/api/kf3-news", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(manyNews) }),
  );
  await page.route("**/api/kf3-news/refresh", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        news: manyNews,
        metadata: { source: "merged", officialCheckedAt: new Date().toISOString() },
      }),
    }),
  );

  await page.goto("/");
  await expect(page.getByTestId("news-metadata").getByText("25件")).toBeVisible();
  const items = page.locator("ul > li");
  await expect(items).toHaveCount(20);

  await page.getByText("お知らせを読み込んでいます...").scrollIntoViewIfNeeded();
  await expect(items).toHaveCount(25);
  await expect(page.getByText("お知らせを読み込んでいます...")).toHaveCount(0);
});

test("検索結果が0件でもエラーや追加読み込みを表示しない", async ({ page }) => {
  await openNewsSearch(page);
  await page.getByRole("button", { name: "検索オプション" }).click();
  await page.getByLabel("キーワード検索:").fill("該当しないキーワード");
  await page.getByRole("button", { name: "検索", exact: true }).click();

  await expect(page.getByText("検索結果: 0件")).toBeVisible();
  await expect(page.locator("ul > li")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("お知らせを読み込んでいます...")).toHaveCount(0);
});
