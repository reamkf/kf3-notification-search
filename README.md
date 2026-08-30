# けもフレ３おしらせ検索

けもフレ３のおしらせを検索することができるツールです。

## 作成した動機

けもフレ３公式サイトのおしらせの**重い**、**遅い**、**検索できない**、**昔のおしらせが辿れない**という課題を解決する目的で作成しました。

## 技術スタック

- [HonoX](https://github.com/honojs/honox)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare KV](https://developers.cloudflare.com/kv/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)

## ローカル開発

[`development.md`](./docs/development.md) を参照してください。

## お知らせ一覧取得フロー

`GET /`はSSG shellを返し、`GET /api/kf3-news`はKV snapshotを返します。KV miss時はR2から復元します。更新は`POST /api/kf3-news/refresh`、アーカイブ更新はQueueとscheduled handler、復元はrestoreが行います。

- [機能共通仕様](./docs/news-spec.md)
- [ページリクエスト仕様](./docs/news-page-request-spec.md)
- [アーカイブ更新仕様](./docs/news-archive-update-spec.md)
- [アーカイブETag条件付き取得の実装仕様](./docs/news-archive-etag-optimization.md)
- [公式お知らせ配信仕様](./docs/official-news-spec.md)

## 公式データの閾値と障害調査

公式データの安全性検証、閾値、障害時のWorkers Logs調査は、次のdocsに集約しています。

- [機能共通仕様の公式データ利用時の安全性検証](./docs/news-spec.md#公式データ利用時の安全性検証)
- [アーカイブ更新仕様の公式データ閾値と障害調査](./docs/news-archive-update-spec.md#公式データの閾値と障害調査)
- [お知らせアーカイブ導入状態](./docs/news-archive-rollout.md)

## 条件付き復元runbook

復元APIの契約とエラーコード、dry-run/applyの運用手順は次のdocsを参照してください。復元Workerはlocalhost専用で、deployや公開routeの追加は行いません。

- [復元APIの契約](./docs/news-spec.md#復元仕様)
- [アーカイブ条件付き復元runbook](./docs/news-archive-restore-runbook.md)
