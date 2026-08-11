# 開発ガイド

## リポジトリをクローン

```bash
git clone https://github.com/remkf/kf3-notification-search
cd ./kf3-notification-search
```

## 依存関係をインストール

```bash
bun install
```

`bun install`の`prepare`でローカルR2へダミーデータを投入し、認証済みの場合は本番R2の初期データで置き換える。本番R2を取得できない場合も、ダミーデータを使って開発を続けられる。ログイン後に本番データを再取得する場合は次を実行する。

```bash
bun run seed:production
```

## Cloudflareへログイン

```bash
bunx wrangler login
```

## KVとR2を準備

### KV namespace

KV namespaceを初回だけ作成し、表示されたIDを`wrangler.toml`の`KF3_NOTIF_CACHE`へ設定する。既存namespaceを使う場合は作成を省略する。

```bash
bunx wrangler kv namespace create KF3_NOTIF_CACHE
```

### 本番データ用R2

既存の場合は作成を省略する。

```bash
bunx wrangler r2 bucket create kf3-notif-data
```

### バックアップ用R2

これらのコマンドを実行する前に、対象アカウントとバケット名を確認する。

```bash
bunx wrangler r2 bucket create kf3-notif-backup
bunx wrangler r2 bucket lifecycle add kf3-notif-backup daily-90d daily/ --expire-days 90
bunx wrangler r2 bucket lock add kf3-notif-backup daily-30d daily/ --retention-days 30
bunx wrangler r2 bucket lock add kf3-notif-backup monthly-30d monthly/ --retention-days 30
bunx wrangler r2 bucket lifecycle list kf3-notif-backup
bunx wrangler r2 bucket lock list kf3-notif-backup
```

Lifecycleは`daily/`だけを90日後に削除する。`monthly/`にはexpire ruleを設定せず長期保持する。Bucket Lockは削除だけでなく上書きも防ぎ、適用後のobjectにも作用する。30日lockより短いexpire期間は設定しない。

### legacyデータの初回移行

既存データを初回移行する場合は、リポジトリ外のファイルを指定してdata bucketへアップロードする。既存の`entries_merged_20241107.json`は互換性のため残し、削除しない。

```bash
bunx wrangler r2 object put kf3-notif-data/entries_merged_20241107.json --file="D:/path/to/entries_merged_20241107.json" --content-type=application/json --remote
```

通常の累積アーカイブは`KF3_NOTIF_DATA/archive/current.json`である。これがない初回だけ`entries_merged_20241107.json`を読み込み、初回更新で`archive/current.json`を作成する。バックアップは`KF3_NOTIF_BACKUP/daily/YYYY/MM/DD/`と`KF3_NOTIF_BACKUP/monthly/YYYY-MM.json`へ保存する。

## ローカルで実行

通常の開発画面は次で起動する。

```bash
bun run dev
```

Worker、ローカルR2、scheduled handlerを確認する場合は次を起動する。

```bash
bun run preview
```

`bun run preview`のR2はローカルストレージである。本番bucketへ接続する`--remote`操作をローカル確認で使用しない。

## scheduled handlerをローカルで確認

`bun run preview`を起動した状態で、03:15 JSTに相当するUTC時刻を指定する。

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json&cron=15+18+*+*+*&time=1785608100000"
```

固定時刻`1785608100000`は`2026-08-01T18:15:00Z`、JSTでは`2026-08-02 03:15:00`である。実装済みWranglerが`/__scheduled` routeを表示する場合は、そのrouteへ読み替える。

確認項目:

- responseの`outcome`が`ok`
- local R2に`archive/current.json`、`daily/2026/08/02/...json`、`monthly/2026-08.json`が作成される
- 内容変更がない2回目はdailyとcurrentが増えず、monthlyは既存扱いになる
- local testがproduction bucketを変更していない

## テストとデプロイ

### テスト

```bash
bun run test
bun run test:e2e
bun run lint
bun run format:check
bunx tsc --noEmit
bun run build
```

全ゲートとローカルscheduled確認が成功し、導入状態ドキュメントの保留事項を解消した後にデプロイする。本番外部状態と未完了の受入項目は [ニュースアーカイブ導入状態](./news-archive-rollout.md) を参照する。

### Healthchecks.io

Healthchecks.ioのHobbyist planで`kf3notif-daily-archive` checkを作成し、Cron scheduleを`15 18 * * *`、timezoneをUTC、grace timeを30分に設定する。メンテナーのメール通知を有効にした後、check固有のping URLを対話入力でWorker secretへ保存する。URL自体をshell履歴、log、Gitへ残さない。

```bash
bunx wrangler secret put HEALTHCHECKS_PING_URL
```

### デプロイ

```bash
bun run deploy
```

デプロイ後はWorkerのURLで`GET /api/kf3-news`を確認する。ニュースの仕様は [ニュース機能共通仕様](./news-spec.md)、ページ取得は [ニュースページリクエスト仕様](./news-page-request-spec.md)、定期実行は [ニュースアーカイブ定期実行更新仕様](./news-archive-scheduled-spec.md) を参照する。

### CloudflareダッシュボードからGit連携で自動デプロイ

CloudflareのWorkers Buildsを使うと、GitHubまたはGitLabのリポジトリへのpushをトリガーに、Workerのbuildとdeployを自動実行できる。

既存Workerを接続する場合:

1. Cloudflare dashboardの **Workers & Pages** で対象Workerを開く。
2. **Settings** の **Builds** から **Connect** を選ぶ。
3. Gitリポジトリとbuild settingsを設定する。
4. 選択したブランチへpushすると、Workers Buildsがbuildとdeployを実行する。

新規Workerの場合は **Workers & Pages** の **Create application** から **Import a repository** を選び、リポジトリを接続して **Save and Deploy** を実行する。

Cloudflare dashboardのWorker名と、対象ディレクトリのWrangler設定にある`name`を一致させる必要がある。詳細は [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) を参照する。
