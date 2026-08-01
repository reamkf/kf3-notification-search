import { showRoutes } from "hono/dev";
import { createApp } from "honox/server";
import { createHono } from "honox/factory";
import type { R2Bucket } from "@cloudflare/workers-types/experimental";
import { newsArraySchema } from "./schema";

const baseApp = createHono();

const oldNewsObjectKey = "entries_merged_20241107.json";
const oldNewsPath = "/" + oldNewsObjectKey;

const getOldNewsObject = async (bucket: R2Bucket) => {
  const object = await bucket.get(oldNewsObjectKey);
  if (!object) {
    throw new Error("旧ニュースデータがR2に見つかりません");
  }
  return object;
};

// 旧ニュースデータをR2から配信
baseApp.on(["GET", "HEAD"], oldNewsPath, async (context) => {
  const object = await getOldNewsObject(context.env.KF3_NOTIF_DATA);
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (object.httpEtag) {
    headers.set("etag", object.httpEtag);
  }

  return new Response(
    context.req.method === "HEAD" ? null : await object.arrayBuffer(),
    { headers }
  );
});

// ニュースデータを取得する関数
const parseNewsData = async (responseBody: string) => {
  const newsJson = JSON.parse(responseBody);
  return newsJson.news;
};

const fetchNewsData = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("ニュースデータの取得に失敗しました: " + response.status);
  }
  return parseNewsData(await response.text());
};

// ニュースを取得するAPIエンドポイント
baseApp.get("/api/kf3-news", async (context) => {
  const cacheKey = "kf3-news"; // キャッシュキー
  const cache = context.env.KF3_NOTIF_CACHE; // キャッシュオブジェクト

  // キャッシュを確認して、存在すればそれを返す
  const cachedNewsData = await cache.get(cacheKey);
  if (cachedNewsData) {
    return context.json(JSON.parse(cachedNewsData));
  }

  // 2024年11月7日までのニュースデータをR2から取得
  const oldNewsDataPromise = getOldNewsObject(context.env.KF3_NOTIF_DATA)
    .then((oldNewsObject) => oldNewsObject.text())
    .then(parseNewsData);

  // ニュースデータを外部から取得
  const newNewsUrl = "https://kemono-friends-3.jp/info/all/entries.txt";
  const newNewsDataPromise = fetchNewsData(newNewsUrl);

  const [oldNewsData, newNewsData] = await Promise.all([
    oldNewsDataPromise,
    newNewsDataPromise,
  ]);

  // ニュースデータをマージ
  const mergedNewsArray = [...oldNewsData, ...newNewsData.flat()];

  // 重複を削除（ニュースのIDを基に一意性を保証）
  const uniqueNewsArray = Array.from(
    new Map(mergedNewsArray.map((item: any) => [item.id, item])).values()
  );

  // ニュースデータを日付の新しい順にソート
  uniqueNewsArray.sort(
    (a: any, b: any) =>
      new Date(b.newsDate).getTime() - new Date(a.newsDate).getTime()
  );

  // データの形式をバリデーション
  const parsedNews = newsArraySchema.safeParse(uniqueNewsArray);
  if (!parsedNews.success) {
    // バリデーションエラーがあればログに記録してエラーレスポンスを返す
    console.error("データ形式のエラー:", parsedNews.error);
    return context.json({ error: "データ形式が無効です" }, 400);
  }

  // キャッシュにニュースデータを保存（5分間有効）
  await cache.put(cacheKey, JSON.stringify(parsedNews.data), {
    expirationTtl: 60 * 5,
  });

  // 成功した場合、パースされたデータを返す
  return context.json(parsedNews.data);
});

const app = createApp({ app: baseApp });

showRoutes(app);

export default app;
