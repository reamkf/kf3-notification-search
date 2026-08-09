import { expect, test, type Page } from "@playwright/test";

const fetchedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

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

const mockNewsApi = async (page: Page, source = "merged") => {
  await page.route("**/api/kf3-news", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "X-KF3-News-Source": source,
        "X-KF3-News-Fetched-At": fetchedAt,
      },
      body: JSON.stringify(news),
    }),
  );
};

const openNewsSearch = async (page: Page) => {
  await mockNewsApi(page);
  await page.goto("/");
  await expect(page.getByText("おしらせの件数: 3件")).toBeVisible();
};

test("ニュース一覧を新しい順に表示し、公式サイトへのリンクを生成する", async ({ page }) => {
  await openNewsSearch(page);
  const items = page.locator("ul > li");

  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText("新イベント開催予告");
  await expect(items.first().getByRole("link")).toHaveAttribute(
    "href",
    "https://kemono-friends-3.jp/info/3",
  );
});

test("公式分類ラベルを値があるニュースにだけ表示する", async ({ page }) => {
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

test("データ取得日時を相対表示する", async ({ page }) => {
  await openNewsSearch(page);

  await expect(page.getByTestId("news-metadata")).toContainText("データ取得: 5分前");
  await expect(page.locator(`time[datetime="${fetchedAt}"]`)).toHaveCount(1);
  await expect(page.getByTestId("news-metadata")).not.toContainText("日本時間");
});

test("公式データ取得失敗時にアーカイブ表示を通知する", async ({ page }) => {
  await mockNewsApi(page, "archive-fallback");
  await page.goto("/");

  await expect(
    page.getByText("公式データを利用できなかったため、保存済みアーカイブを表示しています。"),
  ).toBeVisible();
  await expect(page.locator("ul > li")).toHaveCount(3);
});

test("キーワード、並び順、期間でニュースを絞り込む", async ({ page }) => {
  await openNewsSearch(page);
  await page.getByRole("button", { name: "検索オプション" }).click();
  await page.getByPlaceholder("(測定 or 掃除) 開催 -予告").fill("測定 OR 掃除");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByText("おしらせの件数: 2件")).toBeVisible();

  await page.getByLabel("ソート順:").selectOption("asc");
  await expect(page.locator("li").first()).toContainText("測定イベント");

  await page.locator("#startDate").fill("2026-08-02");
  await page.locator("#endDate").fill("2026-08-02");
  await expect(page.getByText("おしらせの件数: 1件")).toBeVisible();
  await expect(page.locator("li")).toContainText("掃除イベント");
});

test("検索オプションの表示状態を再読み込み後も保持する", async ({ page }) => {
  await openNewsSearch(page);
  const optionsButton = page.getByRole("button", { name: "検索オプション" });

  await expect(page.locator("div.max-h-0")).toHaveCount(1);
  await optionsButton.click();
  await expect(page.locator("div.max-h-screen")).toHaveCount(1);
  await page.reload();
  await expect(page.getByText("おしらせの件数: 3件")).toBeVisible();
  await expect(page.locator("div.max-h-screen")).toHaveCount(1);
});

test("APIエラー時にエラーを表示し、ニュース一覧を表示しない", async ({ page }) => {
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

test("20件を超えるニュースをスクロールに応じて追加表示する", async ({ page }) => {
  const manyNews = Array.from({ length: 25 }, (_, index) => ({
    targetUrl: `/info/${index + 1}`,
    title: `ニュース${index + 1}`,
    newsDate: `2026年08月${String((index % 8) + 1).padStart(2, "0")}日 12時00分00秒`,
    updated: "",
  }));
  await page.route("**/api/kf3-news", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(manyNews) }),
  );

  await page.goto("/");
  await expect(page.getByText("おしらせの件数: 25件")).toBeVisible();
  const items = page.locator("ul > li");
  await expect(items).toHaveCount(20);

  await page.getByRole("status").scrollIntoViewIfNeeded();
  await expect(items).toHaveCount(25);
  await expect(page.getByText("ニュースを読み込んでいます...")).toHaveCount(0);
});

test("検索結果が0件でもエラーや追加読み込みを表示しない", async ({ page }) => {
  await openNewsSearch(page);
  await page.getByRole("button", { name: "検索オプション" }).click();
  await page.getByPlaceholder("(測定 or 掃除) 開催 -予告").fill("該当しないキーワード");
  await page.getByRole("button", { name: "検索", exact: true }).click();

  await expect(page.getByText("おしらせの件数: 0件")).toBeVisible();
  await expect(page.locator("ul > li")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("ニュースを読み込んでいます...")).toHaveCount(0);
});
