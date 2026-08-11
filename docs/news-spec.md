# ニュース機能共通仕様

## この仕様の位置づけ

本書は、ニュースアーカイブに関する共通契約と各処理仕様への入口を定義する。実行主体ごとの処理順、書き込み責務、失敗時の扱いは次の文書に分けて記載する。

| 実行主体                   | 入口                                 | 主な責務                                                     | 書き込み可能なデータ                                                   |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| ユーザーのページリクエスト | `GET /api/kf3-news`                  | 累積アーカイブと公式データを統合し、クライアント用一覧を返す | cache miss時のKV結果キャッシュだけ                                     |
| 定期実行                   | Cronから呼ばれるscheduled handler    | 公式データを検証し、累積アーカイブとバックアップを更新する   | `archive/current.json`、daily、monthly、公式ETag state、必要時のKV削除 |
| 復元操作                   | localhost専用Workerの`POST /restore` | 運用時にスナップショットからcurrentを復元する                | apply時の`archive/current.json`とKV削除                                |

### 実行主体ごとの詳細

- [公式ニュース配信仕様](./official-news-spec.md) は、公式データ形式、HTTP応答、ETagの契約を扱う。
- [ニュースページリクエスト仕様](./news-page-request-spec.md) は`GET /api/kf3-news`のcache hit、cache miss、公式データとの統合、fallback、レスポンス形式を扱う。
- [定期実行更新仕様](./news-archive-scheduled-spec.md) はCron実行、currentとバックアップの更新、公式データの安全性検証、heartbeat、構造化ログを扱う。
- [ニュースアーカイブETag条件付き取得の実装仕様](./news-archive-etag-optimization.md) は、両方の処理にまたがる条件付き取得の実装上の最適化を扱う。
- [ニュースアーカイブ導入状態](./news-archive-rollout.md) は、本番外部状態と受け入れ確認の記録を扱う。
- [ニュースアーカイブ条件付き復元runbook](./news-archive-restore-runbook.md) は、復元操作の手順を扱う。

## 共通の境界

### 定期実行とユーザーリクエストの違い

定期実行はアーカイブの正しさを確定させる唯一の通常経路である。公式データを検証してcurrentを更新し、更新前のdailyと月次のmonthlyをバックアップする。ユーザーのページリクエストは、定期実行が確定したcurrentを参照しながら画面表示用の結果を作るだけであり、アーカイブ本体、バックアップ、公式ETag stateを更新しない。

ユーザーリクエストで公式データを取得できない場合は、正常な累積アーカイブだけを返して検索を継続する。これは一時的な表示用fallbackであり、currentの更新やバックアップ作成を代替しない。

### 共有データの読み書き責務

| データ                                | 定期実行                              | ユーザーリクエスト                                  |
| ------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| `archive/current.json`                | 検証して条件付き更新する              | 読み込む。304時はETag条件付きで本文を読む           |
| `archive/official-fetch-state.json`   | 条件付き取得の結果を保存する          | 読み込むだけ。更新しない                            |
| `daily/...`                           | current更新直前の元バイト列を保存する | 触れない                                            |
| `monthly/...`                         | 月最初の正常状態を保存する            | 触れない                                            |
| `KF3_NOTIF_CACHE/kf3-news`            | current更新後に削除する               | cache hitでは読むだけ、cache missでは結果を保存する |
| legacy `entries_merged_20241107.json` | currentがない初回移行時だけ入力にする | currentがない場合の読み込み元にする                 |

`archive/current.json`が存在しない場合だけlegacyデータを読み込む。`archive/current.json`が存在するもののJSONまたは内容が不正な場合はlegacyデータへフォールバックせず、異常として扱う。これにより、壊れたcurrentを見逃さない。

## 利用者から見た共通の振る舞い

- `GET /api/kf3-news`は、過去に保存したお知らせと現在の公式お知らせを統合した一覧を返す。
- 公式サイトからお知らせが削除されても、累積アーカイブに保存済みの項目は一覧に残る。
- 同じIDのお知らせが公式側で更新された場合は、公式側の内容を優先する。
- 公式サイトを一時的に取得できない場合も、正常な累積アーカイブがあれば検索を継続できる。
- APIレスポンス形式はトップレベルのJSON配列とする。

## 構成要素

| 種別             | 名前またはキー                                     | 役割                                                  |
| ---------------- | -------------------------------------------------- | ----------------------------------------------------- |
| 公式ニュース配信 | `docs/official-news-spec.md`                       | 公式データ形式、HTTP応答、ETagの契約                  |
| 本番R2           | `KF3_NOTIF_DATA/archive/current.json`              | 通常使用する累積アーカイブ                            |
| 本番R2           | `KF3_NOTIF_DATA/archive/official-fetch-state.json` | 公式ETagとcurrent R2 ETagの対応状態                   |
| 本番R2           | `KF3_NOTIF_DATA/entries_merged_20241107.json`      | 初回移行と互換配信用のlegacyデータ                    |
| バックアップR2   | `KF3_NOTIF_BACKUP/daily/...`                       | 更新直前の累積アーカイブ                              |
| バックアップR2   | `KF3_NOTIF_BACKUP/monthly/...`                     | 各月最初の正常実行時点の本番反映済みアーカイブ        |
| Workers KV       | `KF3_NOTIF_CACHE`の`kf3-news`                      | APIレスポンスのキャッシュ                             |
| 監視             | `HEALTHCHECKS_PING_URL`                            | scheduled処理の開始、成功、失敗を通知する任意のsecret |

## 保存データの契約

累積アーカイブは次の形のJSONオブジェクトとする。

```json
{
  "news": [
    {
      "id": 1234567890,
      "targetUrl": "/info/detail/1234567890.html",
      "title": "お知らせのタイトル",
      "newsDate": "2026年08月02日 12時00分00秒",
      "updated": "",
      "category": "お知らせ"
    }
  ]
}
```

各項目は保存時と復元時に次の条件を満たす必要がある。通常のAPIとscheduled処理で保存済みアーカイブを読む際は、JSON構造、必須フィールドの型、正のID、ID一意性だけを検証し、全件の日付解析は繰り返さない。

| フィールド  | 条件                                               |
| ----------- | -------------------------------------------------- |
| `id`        | 正の整数。ドキュメント内で一意                     |
| `targetUrl` | 空でない文字列                                     |
| `title`     | 空でない文字列                                     |
| `newsDate`  | `yyyy年MM月dd日 HH時mm分ss秒`形式の実在するJST日時 |
| `updated`   | 文字列                                             |
| `category`  | 省略可能な文字列                                   |

公式サイト側の項目追加に追従できるよう、保存用データでは未知フィールドを保持する。

## 公式データとETag

公式サーバーのニュースデータ形式とHTTP ETagの契約は [公式ニュース配信仕様](./official-news-spec.md) にまとめる。定期実行とページリクエストはこの外部契約を共有する。ETag stateの保存と条件付き取得の実装は [ニュースアーカイブETag条件付き取得の実装仕様](./news-archive-etag-optimization.md) を参照する。

## 公式データ利用時の安全性検証

定期実行とページリクエストが公式データを採用する際は、公式配信元の契約とは別に、Worker側で次の安全性検証を行う。

| 定数                               | 現在値             | 制約                       | 目的                             |
| ---------------------------------- | ------------------ | -------------------------- | -------------------------------- |
| `MAX_OFFICIAL_RESPONSE_BYTES`      | `10 * 1024 * 1024` | レスポンス本文の最大サイズ | 異常に大きい応答を早期に停止する |
| `OFFICIAL_FETCH_TIMEOUT_MS`        | `10_000`           | 公式レスポンス取得時間     | 停止した応答からfallbackする     |
| `MIN_OFFICIAL_ENTRY_COUNT`         | `1_900`            | 公式データの最小件数       | 部分取得や大幅な欠落を検知する   |
| `MAX_UPDATED_EXISTING_ENTRY_COUNT` | `100`              | 変更できる既存IDの最大数   | 大量改変を検知する               |

さらに、次を確認する。

- HTTPステータスが成功で、本文が存在する。
- `Content-Length`がある場合は数字だけの10進整数として解釈でき、10 MiB以下である。
- 本文をストリームで読みながら実バイト数を数え、10 MiBを超えた時点で読み込みを中止する。
- JSONの基本構造、必須フィールドの型、IDの正の整数、一意性を検証する。
- 公式データの新規または変更項目の`targetUrl`が`/`で始まる公式サイト内の相対パスである。
- 公式データの新規または変更項目の`newsDate`が厳密な形式と実在する日時を満たす。
- 公式データの既存IDに対する変更件数が100件を超えない。

定期実行で検証に失敗した場合は、R2とKVを変更せず処理全体を失敗させる。ページリクエストで検証に失敗した場合は、正常な累積アーカイブがあれば公式データを採用せずarchive-fallbackへ切り替える。閾値を変更する場合は、定数とテストを同時に更新する。

## 復元仕様

復元機能は本番Workerの公開APIではない。`wrangler.restore.toml`でlocalhost専用Workerを起動し、remote binding経由で本番R2とKVを操作する。復元Worker自体はデプロイしない。実際の操作手順は [ニュースアーカイブ条件付き復元runbook](./news-archive-restore-runbook.md) を参照する。

復元APIは`POST http://127.0.0.1:8790/restore`で、`daily/...json`または`monthly/...json`のスナップショットだけを受け付ける。日次キーは`daily/YYYY/MM/DD/<filename>.json`、月次キーは`monthly/YYYY-MM.json`に限定し、日次の`filename`には英数字、ピリオド、アンダースコア、ハイフンだけを許可する。request URLのhostnameが`localhost`、`127.0.0.1`、`[::1]`のいずれでもない場合は拒否する。

### dry-run

`mode`を省略するか`dry-run`を指定すると、次を検証して表示するだけで書き込みは行わない。

- スナップショットの保存用スキーマ、全日付、ID一意性
- 正規化JSONとSHA-256 digest
- 件数、最古日、最新日
- 現在の`archive/current.json`のETag
- applyで予定されるcurrent置換とKV削除

`archive/current.json`が存在しない場合はHTTP 409の`current_not_found`とする。復元Workerはcurrentの初回作成には使用しない。

```json
{
  "snapshotKey": "daily/YYYY/MM/DD/<snapshot>.json"
}
```

### apply

運用手順として、applyでは直前のdry-runで確認した`snapshotDigest`と`currentEtag`を再入力する。復元Workerはdry-runの実行履歴、セッション、確認トークンを保存しない。apply時にスナップショットとcurrentを再度読み、入力値がその時点のdigestとETagに一致することを確認する処理を、直前のdry-runから状態が変わっていないことの確認として使用する。

```json
{
  "mode": "apply",
  "snapshotKey": "daily/YYYY/MM/DD/<snapshot>.json",
  "snapshotDigest": "<dry-runで確認したdigest>",
  "currentEtag": "<dry-runで確認したETag>"
}
```

apply時にもスナップショットと現在のETagを再検証する。digestまたはETagが一致しない場合は何も変更しない。currentにはスナップショットの元のバイト列ではなく、検証時に生成した正規化JSONを書き込む。currentは`etagMatches`条件付きで更新し、競合時に無条件更新へ切り替えない。current更新に成功した後だけKVの`kf3-news`を削除する。

KV削除に失敗した場合は、currentがすでに復元済みであることが分かるよう更新後ETagをエラーレスポンスに含める。

復元APIのエラーは`{"error":{"code":"<code>","message":"<message>"}}`形式とし、追加情報がある場合は`error`内へ含める。主なHTTPステータスとcodeは次のとおり。

| HTTP | code                          | 条件                                             |
| ---: | ----------------------------- | ------------------------------------------------ |
|  400 | `invalid_json`                | request bodyがJSONではない                       |
|  400 | `invalid_request`             | request bodyがオブジェクトではない               |
|  400 | `invalid_mode`                | modeが`dry-run`または`apply`ではない             |
|  400 | `invalid_snapshot_key`        | snapshot keyが許可形式ではない                   |
|  400 | `invalid_snapshot_digest`     | snapshot digestが文字列ではない                  |
|  400 | `invalid_current_etag`        | current ETagが文字列ではない                     |
|  400 | `apply_confirmation_required` | applyの確認値が不足している                      |
|  403 | `localhost_only`              | localhost以外から要求された                      |
|  404 | `not_found`                   | `/restore`以外のpathが要求された                 |
|  404 | `snapshot_not_found`          | snapshotが存在しない                             |
|  405 | `method_not_allowed`          | POST以外で`/restore`が要求された                 |
|  409 | `current_not_found`           | currentが存在しない                              |
|  409 | `snapshot_digest_mismatch`    | snapshot digestが再検証結果と一致しない          |
|  409 | `current_etag_mismatch`       | 入力ETagが現在のcurrent ETagと一致しない         |
|  409 | `current_update_conflict`     | 条件付きcurrent更新が競合した                    |
|  422 | `snapshot_json_invalid`       | snapshotがJSONではない                           |
|  422 | `snapshot_validation_failed`  | snapshotが保存用スキーマまたは日付検証を通らない |
|  502 | `snapshot_read_failed`        | snapshotのR2読み込みに失敗した                   |
|  502 | `current_read_failed`         | currentのR2メタデータ読み込みに失敗した          |
|  502 | `current_put_failed`          | currentのR2更新に失敗した                        |
|  502 | `cache_delete_failed`         | current更新後のKV削除に失敗した                  |
|  500 | `restore_failed`              | 上記以外の復元処理に失敗した                     |

## 導入状態と対象外

このブランチにはscheduled handler、Cron設定、バックアップbinding、監視、復元ツールが含まれる。Workers Freeを継続し、Cron Triggerは1本だけ登録する方針である。本仕様はコードとリポジトリ設定が提供する振る舞いを示すものであり、現HEADが本番Workerへ反映済みであること、本番Cronが登録済みであること、初回実行や受け入れが完了していることを保証しない。現在の外部状態、保留理由、再開手順、未完了の受け入れ条件は [ニュースアーカイブ導入状態](./news-archive-rollout.md) に記載する。

次は本変更の対象外とする。

- 検索UIの変更
- legacyデータの削除または上書き
- `archive/current.json`の外部公開
- 復元用の公開管理routeや復元Workerのデプロイ
- Cloudflareアカウント全体の喪失に備えた別アカウント、別ストレージへの複製
