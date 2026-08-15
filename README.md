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

`GET /`はSSR shellだけを返します。shell表示後の`GET /api/kf3-news`はKV snapshotを即時返し、KV miss時はR2 currentまたはlegacy snapshotを投影します。公式取得、検証、mergeを行う`POST /api/kf3-news/refresh`は別リクエストで、実行中は202、成功時は`{news, metadata}`を表示用KVへ保存して200、cooldownは429、依存障害は503を返します。refreshはR2 CAS leaseと5分cooldownで制限し、Cloudflare Rate LimitingとWAFで保護します。永続archiveの更新はscheduledだけが行い、restoreはsnapshotからcurrentを復元します。

- [機能共通仕様](./docs/news-spec.md)
- [ページリクエスト仕様](./docs/news-page-request-spec.md)
- [アーカイブ定期実行更新仕様](./docs/news-archive-scheduled-spec.md)
- [アーカイブETag条件付き取得の実装仕様](./docs/news-archive-etag-optimization.md)
- [公式お知らせ配信仕様](./docs/official-news-spec.md)

## 公式データの閾値と障害調査

公式データの安全性検証、閾値、障害時のWorkers Logs調査は、次のdocsに集約しています。

- [機能共通仕様の公式データ利用時の安全性検証](./docs/news-spec.md#公式データ利用時の安全性検証)
- [定期実行仕様の公式データ閾値と障害調査](./docs/news-archive-scheduled-spec.md#公式データの閾値と障害調査)
- [お知らせアーカイブ導入状態](./docs/news-archive-rollout.md)

## 条件付き復元runbook

復元APIの契約とエラーコード、dry-run/applyの運用手順は次のdocsを参照してください。復元Workerはlocalhost専用で、deployや公開routeの追加は行いません。

- [復元APIの契約](./docs/news-spec.md#復元仕様)
- [アーカイブ条件付き復元runbook](./docs/news-archive-restore-runbook.md)
