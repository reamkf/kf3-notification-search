# けもフレ３おしらせ検索

けもフレ３のおしらせを検索することができるツールです。Cloudflare Workersの `workers.dev` URLで公開します。

## 作成した動機

このツールを作った動機は、けもフレ３公式サイトのおしらせが**重い**、**遅い**、**検索できない**、**昔のおしらせが辿れない**を解決させたいと思ったことにあります。
けもフレ３公式サイトに負担のない方法でおしらせを取得する方法が見つかったので、このツールを作成しました。

## 使った技術

- [HonoX](https://github.com/honojs/honox)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare KV](https://developers.cloudflare.com/kv/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)

## ローカルでの再現方法

### 1. このリポジトリをクローンする

```bash
git clone https://github.com/remkf/kf3-notification-search
```

```bash
cd ./kf3-notification-search
```

### 2. 依存関係をインストールする

```bash
bun install
```

### 3. wranglerでCloudflareにログインする

```bash
wrangler login
```

### 4. Cloudflare KVの名前空間を作成する

```bash
wrangler kv namespace create KF3_NOTIF_CACHE
```

```text
 ⛅️ wrangler 3.67.1
-------------------

🌀 Creating namespace with title "kv-worker-KF3_NOTIF_CACHE"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "KF3_NOTIF_CACHE"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

上記の `id` を `wrangler.toml` の `id` にダブルクオーテーション付きで設定する。

### 5. Cloudflare R2バケットを作成する

```bash
wrangler r2 bucket create kf3-notif-data
```

旧ニュースデータをR2へアップロードする。JSONファイルはリポジトリに含めず、管理者が保管しているローカルファイルを指定する。

```bash
wrangler r2 object put kf3-notif-data/entries_merged_20241107.json --file=./entries_merged_20241107.json --content-type=application/json
```

R2バケットは非公開のまま使用し、Workerの次のURLから配信する。

```text
https://kf3notif.<アカウントのサブドメイン>.workers.dev/entries_merged_20241107.json
```

### 6. 開発環境で実行する

```bash
bun run dev
```

Workerの実行環境で確認する場合は、次のコマンドを使用します。

```bash
bun run preview
```

### 7. デプロイする

```bash
bun run deploy
```

デプロイ後に表示される `https://kf3notif.<アカウントのサブドメイン>.workers.dev/` を利用します。カスタムドメインの設定は不要です。

### 8. テストケースを実行する

```bash
bun run test
```
