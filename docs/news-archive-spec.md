# ニュースアーカイブ機能仕様

## 概要

本機能は、けものフレンズ3公式サイトのお知らせを累積保存し、公式サイトから掲載終了したお知らせも検索できる状態を維持する。

日常の検索では累積アーカイブと最新の公式データを統合して返す。累積アーカイブ自体の更新は毎日のscheduled処理だけが行い、更新前のスナップショット、同時実行対策、異常データの検知を組み合わせて既存データの消失や意図しない上書きを防ぐ。

## 利用者から見た振る舞い

- `GET /api/kf3-news`は、過去に保存したお知らせと現在の公式お知らせを統合した一覧を返す。
- 公式サイトからお知らせが削除されても、累積アーカイブに保存済みの項目は一覧に残る。
- 同じIDのお知らせが公式側で更新された場合は、公式側の内容を優先する。
- 公式サイトを一時的に取得できない場合も、正常な累積アーカイブがあれば検索を継続できる。
- APIレスポンス形式はトップレベルのJSON配列とする。

```json
[
  {
    "targetUrl": "/info/detail/1234567890.html",
    "title": "お知らせのタイトル",
    "newsDate": "2026年08月02日 12時00分00秒",
    "updated": ""
  }
]
```

レスポンスに含めるフィールドは`targetUrl`、`title`、`newsDate`、`updated`の4つだけとする。保存用データに含まれる`id`、`category`、その他の未知フィールドはクライアントへ返さない。

## 構成要素

| 種別           | 名前またはキー                                     | 役割                                                  |
| -------------- | -------------------------------------------------- | ----------------------------------------------------- |
| 公式データ     | `https://kemono-friends-3.jp/info/all/entries.txt` | 最新のお知らせを取得する入力元                        |
| 本番R2         | `KF3_NOTIF_DATA/archive/current.json`              | 通常使用する累積アーカイブ                            |
| 本番R2         | `KF3_NOTIF_DATA/entries_merged_20241107.json`      | 初回移行と互換配信用のlegacyデータ                    |
| バックアップR2 | `KF3_NOTIF_BACKUP/daily/...`                       | 更新直前の累積アーカイブ                              |
| バックアップR2 | `KF3_NOTIF_BACKUP/monthly/...`                     | 各月最初の正常実行時点の本番反映済みアーカイブ        |
| Workers KV     | `KF3_NOTIF_CACHE`の`kf3-news`                      | APIレスポンスのキャッシュ                             |
| 監視           | `HEALTHCHECKS_PING_URL`                            | scheduled処理の開始、成功、失敗を通知する任意のsecret |

`archive/current.json`が存在しない場合だけlegacyデータを読み込む。`archive/current.json`が存在するもののJSONまたは内容が不正な場合はlegacyデータへフォールバックせず、異常として扱う。これにより、壊れたcurrentが見逃されることを防ぐ。

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

scheduled処理でcurrentを更新する場合は、項目を`newsDate`と`id`で決定的にソートし、JSONを1回だけシリアライズする。オブジェクトのキーは再帰的に並べ替えず、SHA-256 digestも計算しない。復元処理では、操作対象を厳密に確認するため、正規化JSONとSHA-256 digestを使用する。

## API取得仕様

`GET /api/kf3-news`は次の順で処理する。

1. KVの`kf3-news`を`getWithMetadata`で読み込む。
2. キャッシュが存在すれば、Worker自身が保存した値として本文を再解析せず、R2や公式サーバーへアクセスせずに返す。KV metadataはレスポンスヘッダーへ変換する。
3. キャッシュがなければ累積アーカイブと公式データを並行して読み込む。
4. 累積アーカイブを基準にIDで統合し、同じIDは公式データで置き換え、新しいIDは末尾へ追加する。公式データを利用できない場合は累積アーカイブだけを採用する。
5. クライアント用の4フィールドへ変換し、トップレベル配列のJSONをKV valueへ保存して返す。

APIでの統合は入力順を維持し、R2の累積アーカイブやバックアップを更新しない。通常結果のKV有効期間は300秒とする。KV valueは従来のニュース配列JSONを維持し、次のmetadataを同じKV keyへ保存する。

```json
{
  "version": 1,
  "source": "merged",
  "fetchedAt": "2026-08-09T12:34:56.789Z"
}
```

`source`は通常の統合結果では`merged`、公式データの取得、解析、検証、統合のいずれかに失敗して累積アーカイブだけを返す場合は`archive-fallback`とする。`fetchedAt`はcache miss時に結果を確定してKVへ保存する直前のISO 8601日時である。APIはmetadataを`X-KF3-News-Source`と`X-KF3-News-Fetched-At`レスポンスヘッダーへ投影する。公式データを利用できなかった場合もHTTP 200を返し、画面上に保存済みアーカイブを表示していることを明示する。fallbackのKV有効期間は60秒とする。

KVの読み込みまたは結果の保存に失敗した場合は、キャッシュを使わない応答へ切り替えずHTTP 500とする。これらの失敗は`news_api_error`として記録する。KV値の完全性は書き込み元で保証し、読み込み時には再検証しない。

metadataのない旧形式のKV valueや不正なmetadataは、ニュース配列を壊さず`source`不明、取得日時不明として返す。旧形式のcache hitで公式データ取得の失敗を推測してはならない。累積アーカイブ自体を読み込めない場合は、公式データだけでは応答せず、HTTP 500と次のエラーを返す。

```json
{
  "error": "ニュースデータの取得に失敗しました"
}
```

互換性維持のため、`GET /entries_merged_20241107.json`と`HEAD /entries_merged_20241107.json`も残す。このrouteはR2オブジェクトを保存用スキーマで検証せず、そのバイト列をそのまま返す。レスポンスには1年間のimmutable cache指定と、取得できた場合はR2のHTTP ETagを付ける。legacyオブジェクトが存在しない場合、またはR2から取得できない場合は5xxとする。`archive/current.json`は公開しない。

## 日次更新仕様

リポジトリ上のCron設定は`15 18 * * *`で、毎日18:15 UTC、JSTでは翌日03:15に実行する。バックアップの日付には実際の処理開始時刻ではなく`ScheduledController.scheduledTime`を使用する。本番Cronの登録状況は [ニュースアーカイブ導入状態](./news-archive-rollout.md) を参照する。

```mermaid
flowchart TD
    Start[scheduled開始] --> Read[累積アーカイブを読む]
    Start --> Fetch[公式データを取得する]
    Read --> Validate[構造検証してIDで統合する]
    Fetch --> Validate
    Validate --> Changed{currentがない、または内容変更あり}
    Changed -->|はい| Daily[更新前データをdailyへ保存]
    Daily --> Current[ETag条件付きでcurrentを更新]
    Current --> Cache[KVキャッシュを削除]
    Cache --> Monthly[当月monthlyを作成または確認]
    Changed -->|いいえ| Monthly
    Monthly --> Log[結果を構造化ログへ記録]
```

更新処理の詳細は次のとおり。

1. `archive/current.json`を読み、存在しない場合だけlegacyデータを読む。
2. 公式データを取得する。アーカイブ読み込みと公式取得は並行して行う。
3. アーカイブと公式データの基本構造、必須フィールドの型、ID一意性を検証し、IDをキーに統合する。公式データの新規または変更項目だけURLと日時を厳密に検証する。同じIDには公式データを採用し、アーカイブにだけ存在するIDは残す。
4. 未知フィールドを含むJSON値のdeep equalityで既存項目と公式項目を比較し、追加件数または変更件数から内容変更の有無を判定する。オブジェクトのキー順だけの違いは変更扱いにしない。
5. 内容変更がある場合だけ、統合結果を`newsDate`の降順、同時刻の場合は`id`の降順で決定的にソートし、JSONへシリアライズする。
6. 内容変更がある場合、更新前のアーカイブの元のバイト列を日次バックアップへ新規作成する。
7. 読み込み時のETagを条件に`archive/current.json`を更新する。初回作成時は、currentが存在しないことを条件にする。
8. current更新に成功した後でKVの`kf3-news`を削除する。
9. 当月の月次バックアップを条件付きで新規作成する。すでに存在する場合は内容を再取得しない。
10. 成否と処理結果を構造化ログへ記録する。

currentがまだなく、legacyデータから移行する初回実行では、統合結果がlegacyと同じでも更新ありとして扱う。これにより、更新前legacyの日次バックアップと`archive/current.json`を作成する。

内容変更がない場合はソート、JSONシリアライズ、日次バックアップ、current更新、KV削除を省略する。ただし、当月の月次バックアップが欠けていれば、読み込み済みcurrentのバイト列から作成を試みる。

## バックアップ仕様

### 日次バックアップ

- キーは`daily/YYYY/MM/DD/<UTC日時>.json`とする。
- `<UTC日時>`は`YYYY-MM-DDTHH-mm-ssZ`形式とし、ミリ秒を省略して時刻区切りのコロンをハイフンへ置き換える。例は`2026-08-01T18-15-00Z`とする。
- ディレクトリの日付はJST、ファイル名の日時はUTCとする。
- currentを変更する直前のアーカイブの元のバイト列を保存する。
- 内容変更がある場合、またはcurrentを初回作成する場合だけ作成する。
- 同じキーがすでにある場合は重複実行または競合として失敗し、既存オブジェクトを読み直さない。

### 月次バックアップ

- キーは`monthly/YYYY-MM.json`とし、年月はJSTで判定する。
- 各月で最初に正常に到達した実行が、本番反映済みのアーカイブを保存する。
- 同じ月のオブジェクトは上書きせず、条件付き作成が競合した場合は保存済みとして扱う。通常のscheduled処理では既存オブジェクトを取得または再検証しない。
- currentの内容変更がない実行でも、月次バックアップが欠けていれば作成する。

日次および月次バックアップの内容は、復元dry-runまたは運用上の完全性監査で厳密に検証する。

運用上、`daily/`は90日後に削除するLifecycle Ruleを設定し、`daily/`と`monthly/`には30日間のBucket Lockを設定する。`monthly/`には期限削除を設定せず長期保持する。

## 公式データの安全性検証

公式レスポンスと統合結果には次の制約を適用する。

| 制約                       |    現在値 | 目的                             |
| -------------------------- | --------: | -------------------------------- |
| レスポンス本文の最大サイズ |    10 MiB | 異常に大きい応答を早期に停止する |
| 公式レスポンス取得時間     |      10秒 | 停止した応答からfallbackする     |
| 公式データの最小件数       |   1,900件 | 部分取得や大幅な欠落を検知する   |
| 1回で変更できる既存ID      | 100件まで | 大量改変を検知する               |

さらに、次をすべて確認する。

- HTTPステータスが成功で、本文が存在する。
- `Content-Length`がある場合は数字だけの10進整数として解釈でき、10 MiB以下である。
- 本文をストリームで読みながら実バイト数を数え、10 MiBを超えた時点で読み込みを中止する。
- 公式データの各項目が必須フィールドの型を満たし、IDが正の整数かつ一意である。
- 公式データの新規または変更項目の`targetUrl`が`/`で始まる公式サイト内の相対パスである。
- 公式データの新規または変更項目の`newsDate`が厳密な形式と実在する日時を満たす。実在する未来日時は許可する。
- 統合は、検証済みの既存IDで初期化したMapへ公式項目を追加または置換する。このアルゴリズムにより、統合後の件数が更新前より減らず、更新前のすべてのIDが残ることを保証し、統合後の全件再走査は行わない。

scheduled処理で公式取得または検証が失敗した場合は、R2とKVを変更せず処理全体を失敗させる。閾値を変更する場合は、実際の公式データが仕様変更されたことを確認し、定数とテストを同時に更新する。

## 同時実行と失敗時の扱い

- current更新には、読み込み時に取得したR2 ETagを使用する。
- currentが未作成の場合は、オブジェクトが存在しないことを条件に作成する。
- 条件付き更新が競合した場合は失敗とし、無条件上書きや自動再試行は行わない。
- 日次バックアップの保存に失敗した場合は、currentとKVを変更しない。
- current更新が競合した場合は、KV削除と月次バックアップへ進まない。先に作成済みの日次バックアップは残す。
- KV削除に失敗した場合、current更新は巻き戻さず、月次バックアップの作成へも進まない。scheduled処理は失敗として終了し、既存キャッシュは有効期限によって解消される。月次バックアップが欠けている場合は、次回の正常実行で作成を再試行する。
- 月次バックアップに失敗した場合、current更新は巻き戻さない。次回の正常実行で月次バックアップ作成を再試行する。

## 監視とログ

`HEALTHCHECKS_PING_URL`が設定されている場合、scheduled handlerは次のheartbeatを送る。

| タイミング | 送信先             |
| ---------- | ------------------ |
| 更新開始前 | `<ping URL>/start` |
| 更新成功後 | `<ping URL>`       |
| 更新失敗後 | `<ping URL>/fail`  |

heartbeatはHTTP POSTで送信する。ping URLの末尾の`/`は取り除いてからsuffixを付け、2xx以外のレスポンスも送信失敗として扱う。heartbeatは10秒でタイムアウトする。heartbeat自体の失敗はアーカイブ更新を中断せず、秘密値を含まない`news_archive_heartbeat_failed`ログを残す。アーカイブ更新が失敗した場合はfail送信を試みた後、元のエラーを再送出してscheduled実行も失敗させる。

主な構造化ログイベントは次のとおり。

| イベント                        | 意味                                          |
| ------------------------------- | --------------------------------------------- |
| `news_archive_update`           | 日次更新が完了した                            |
| `news_archive_update_failed`    | 日次更新がいずれかの段階で失敗した            |
| `news_archive_heartbeat_failed` | heartbeat送信に失敗した                       |
| `news_api_fallback`             | APIが公式データを使えずアーカイブだけを返した |
| `news_api_error`                | APIがレスポンスを構築できなかった             |

更新成功ログには更新有無、実行時刻、各件数、公式レスポンスのバイト数、バックアップキー、ETag、処理時間を含める。処理時間は外部I/O待ちを含む経過時間であり、WorkersのCPU時間判定には使用しない。失敗ログには処理段階とエラー詳細を含めるが、公式レスポンス本文やheartbeat URLは含めない。

## 復元仕様

復元機能は本番Workerの公開APIではない。`wrangler.restore.toml`でlocalhost専用Workerを起動し、remote binding経由で本番R2とKVを操作する。復元Worker自体はデプロイしない。

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

このブランチにはscheduled handler、Cron設定、バックアップbinding、監視、復元ツールが含まれる。Workers Freeを継続し、Cron Triggerは1本だけ登録する方針と本番登録は完了しているが、CPU制限への適合確認と初回実行後の受け入れ確認は未完了である。したがって、本仕様はコードとリポジトリ設定が提供する振る舞いを示すものであり、本番Cronの初回実行と受け入れが完了していることを意味しない。現在の外部状態、保留理由、再開手順、未完了の受け入れ条件は [ニュースアーカイブ導入状態](./news-archive-rollout.md) に記載する。

次は本変更の対象外とする。

- 検索UIの変更
- legacyデータの削除または上書き
- `archive/current.json`の外部公開
- 復元用の公開管理routeや復元Workerのデプロイ
- Cloudflareアカウント全体の喪失に備えた別アカウント、別ストレージへの複製
