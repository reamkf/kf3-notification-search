# けもフレ３おしらせ検索

けもフレ３のおしらせを検索することができるツールです。

## 作成した動機

けもフレ３公式サイトのおしらせの**重い**、**遅い**、**検索できない**、**昔のおしらせが辿れない**という課題を解決する目的で作成しました。

## 技術スタック

- [HonoX](https://github.com/honojs/honox)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare KV](https://developers.cloudflare.com/kv/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)

## ローカル開発

依存関係のインストール、Cloudflareのリソース準備、ローカルWorkerとscheduled handlerの確認、テスト、デプロイ手順、Cloudflare Workers BuildsによるGit push自動デプロイの設定は [開発ガイド](./docs/development.md) にまとめています。

## お知らせ一覧取得フロー

`GET /api/kf3-news`のcache hit、cache miss、公式データとの統合、scheduledによるアーカイブ更新、ETag条件付き取得の詳細は、次のdocsを参照してください。

- [ニュースページリクエスト仕様](./docs/news-page-request-spec.md)
- [ニュースアーカイブ定期実行更新仕様](./docs/news-archive-scheduled-spec.md)
- [ニュースアーカイブETag条件付き取得の実装仕様](./docs/news-archive-etag-optimization.md)
- [公式ニュース配信仕様](./docs/official-news-spec.md)

## 公式データの閾値と障害調査

公式データの安全性検証、閾値、障害時のWorkers Logs調査は、次のdocsに集約しています。

- [ニュース機能共通仕様の公式データ利用時の安全性検証](./docs/news-spec.md#公式データ利用時の安全性検証)
- [定期実行仕様の公式データ閾値と障害調査](./docs/news-archive-scheduled-spec.md#公式データの閾値と障害調査)
- [ニュースアーカイブ導入状態](./docs/news-archive-rollout.md)

## 条件付き復元runbook

復元APIの契約とエラーコード、dry-run/applyの運用手順は次のdocsを参照してください。復元Workerはlocalhost専用で、deployや公開routeの追加は行いません。

- [復元APIの契約](./docs/news-spec.md#復元仕様)
- [ニュースアーカイブ条件付き復元runbook](./docs/news-archive-restore-runbook.md)
