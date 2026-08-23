# お知らせ機能共通仕様

## この仕様の位置づけ

本書は、お知らせ表示、表示用データの更新、永続アーカイブ、復元に関する共通契約と各処理仕様への入口を定義する。実行主体ごとの処理順、書き込み責務、失敗時の扱いは次の文書に分けて記載する。

| 実行主体           | 入口                                 | 主な責務                                                                    | 書き込み可能なデータ                                       |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| ページ表示         | `GET /`                              | Static Assetsからお知らせ表示用のSSG済みshellを返す                         | なし                                                       |
| 表示データ取得     | `GET /api/kf3-news`                  | KVの表示用snapshotを返し、KV miss時はR2 snapshotを投影する                  | なし                                                       |
| 表示データrefresh  | `POST /api/kf3-news/refresh`         | 公式データを取得、検証、mergeし、成功結果をKVへ保存してQueueへ通知する      | 表示用KV、refresh制御metadata、archive更新Queueへのpublish |
| Queue consumer     | `kf3-notif-archive-update`           | messageを検証し、`updateNewsArchive(trigger=queue)`を別invocationで実行する | current、daily、monthly、公式ETag state                    |
| scheduled fallback | Cronから呼ばれるscheduled handler    | 03:15 JSTに`updateNewsArchive(trigger=scheduled)`を実行するfallback         | current、daily、monthly、公式ETag state、必要時のKV削除    |
| 復元操作           | localhost専用Workerの`POST /restore` | snapshotからcurrentを条件付きで復元する                                     | apply時の`archive/current.json`とKV削除                    |

### 実行主体ごとの詳細

- [公式お知らせ配信仕様](./official-news-spec.md) は、公式データ形式、HTTP応答、ETagの契約を扱う。
- [お知らせページリクエスト仕様](./news-page-request-spec.md) は、`/`、`GET /api/kf3-news`、`POST /api/kf3-news/refresh`の表示フローとHTTP契約を扱う。
- [アーカイブ更新仕様](./news-archive-update-spec.md) は、Queue consumerと03:15 JSTのscheduled fallbackによるcurrent、backup、公式ETag stateの更新、heartbeat、retry、構造化ログを扱う。
- [お知らせアーカイブETag条件付き取得の実装仕様](./news-archive-etag-optimization.md) は、Queue consumerとscheduled fallbackに共通する公式ETagと304経路の最適化を扱う。
- [お知らせアーカイブ導入状態](./news-archive-rollout.md) は、デプロイ後の受け入れ確認、公開refreshの保護、障害時の運用確認を扱う。
- [お知らせアーカイブ条件付き復元runbook](./news-archive-restore-runbook.md) は、復元操作の手順を扱う。

## 共通の境界

### 表示データと永続アーカイブの違い

表示用KVは、refreshが正常完了した表示用配列のsnapshotを保持する。`GET /api/kf3-news`はこのsnapshotを読み、KVにない場合だけ`archive/current.json`またはlegacy objectを読み込んでクライアント用配列へ投影する。GETはR2の投影結果をKVへ書き戻さず、公式サーバーからの取得やアーカイブとのmergeも行わない。

`POST /api/kf3-news/refresh`は表示用データを最新化する公開操作である。R2のCAS leaseと5分cooldownで同時実行と連続実行を制限し、leaseを取得した要求だけが公式データの取得、検証、mergeを行う。KV finalization前に同じtokenのleaseをCASで5分間へ延長し、成功した結果を表示用KVへ保存して`{news, metadata}`形式でレスポンス本文へ返す。

refreshは表示用KVとrefresh制御metadataだけを変更する。merge差分がある場合またはcurrentが未作成の場合は`kf3-notif-archive-update` Queueへbest-effortで通知するが、`archive/current.json`、daily、monthly、公式ETag stateはrefreshから変更しない。Queue consumerが別invocationで`updateNewsArchive(trigger=queue)`を実行し、refresh由来の表示KVを維持する。03:15 JSTのscheduled handlerは`trigger=scheduled`でfallback更新を行い、current更新時に表示KVを削除する。Queue送信に失敗してもrefreshは200を返す。currentをsnapshotへ戻す操作はrestoreの責務である。

### 共有データの読み書き責務

| データ                                | GET `/api/kf3-news`                    | POST `/api/kf3-news/refresh`            | Queue consumer                    | scheduled fallback                | restore                 |
| ------------------------------------- | -------------------------------------- | --------------------------------------- | --------------------------------- | --------------------------------- | ----------------------- |
| `archive/current.json`                | 読み込み、snapshot投影                 | 読み込み、mergeの入力                   | 検証してETag条件付き更新          | 検証してETag条件付き更新          | applyで条件付き置換     |
| `archive/official-fetch-state.json`   | 触れない                               | 変更しない                              | 条件付き取得の結果を保存          | 条件付き取得の結果を保存          | 変更しない              |
| `daily/...`                           | 触れない                               | 触れない                                | current更新直前の元バイト列を保存 | current更新直前の元バイト列を保存 | 読み込みのみ            |
| `monthly/...`                         | 触れない                               | 触れない                                | 月最初の正常状態を保存            | 月最初の正常状態を保存            | 読み込みのみ            |
| `KF3_NOTIF_CACHE/kf3-news`            | snapshotを読み、miss時はR2から直接応答 | 成功結果を保存                          | refresh由来のsnapshotを維持       | current更新成功後に削除           | current更新成功後に削除 |
| refresh制御metadata                   | 触れない                               | CAS leaseとcooldownを更新               | 触れない                          | 触れない                          | 触れない                |
| `kf3-notif-archive-update` Queue      | 触れない                               | merge差分またはcurrent未作成時にpublish | messageをconsume                  | 触れない                          | 触れない                |
| legacy `entries_merged_20241107.json` | currentがない場合の読み込み元          | currentがない場合のmerge入力            | currentがない初回移行の入力       | currentがない初回移行の入力       | 入力対象外              |

`archive/current.json`が存在しない場合だけlegacyデータを読み込む。currentが存在するもののJSONまたは内容が不正な場合はlegacyへフォールバックせず、異常として扱う。refreshのmerge入力でもこの境界を維持する。

### ページ表示とデータ取得の分離

`GET /`はStatic AssetsからSSG済みshellを返し、お知らせデータを取得しない。Workerを起動せず、ブラウザのお知らせ取得はshell表示後に`GET /api/kf3-news`へ送る別のHTTPリクエストで行う。GETからrefreshをdispatchしたり、`waitUntil`で公式取得を継続したりしない。refreshが必要な場合は`POST /api/kf3-news/refresh`を別リクエストとして呼び出す。

この分離により、shellの応答時間と公式取得、検証、mergeのCPU時間を別リクエストとして計測する。refresh実行中もGETは既存のKV snapshotを返し、refreshが成功するまで表示用KVを置き換えない。

## 利用者から見た共通の振る舞い

- `GET /`はStatic Assetsからお知らせデータを含まないSSG済みshellを返す。
- `GET /api/kf3-news`はKV snapshotを即時返却する。
- GETのKV missでは、currentまたはlegacyのsnapshotをクライアント用配列へ投影して直接返す。表示用KVへの書き込み、公式取得、mergeは行わない。
- `POST /api/kf3-news/refresh`の成功時は、公式側の更新を反映した配列と表示用metadataをKVへ保存し、`{news, metadata}`形式で返す。
- 公式サイトからお知らせが削除されても、Queue consumerまたはscheduled fallbackでcurrentへ保存済みの項目は残る。
- 同じIDのお知らせが公式側で更新された場合、Queue consumer、scheduled fallback、またはrefreshのmergeでは公式側の内容を優先する。
- refreshの失敗時は、直前のKV snapshotを置き換えない。
- GETの成功レスポンスはトップレベルのJSON配列とする。refresh成功レスポンスは`{news, metadata}`形式とし、制御またはエラー時は契約したJSONオブジェクトとする。

## 構成要素

| 種別             | 名前またはキー                                     | 役割                                                                          |
| ---------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| 公式お知らせ配信 | `docs/official-news-spec.md`                       | 公式データ形式、HTTP応答、ETagの契約                                          |
| 本番R2           | `KF3_NOTIF_DATA/archive/current.json`              | 通常使用する累積アーカイブ                                                    |
| 本番R2           | `KF3_NOTIF_DATA/archive/official-fetch-state.json` | Queue consumerとscheduledの公式ETag、current R2 ETagの対応状態                |
| 本番R2           | `KF3_NOTIF_DATA/entries_merged_20241107.json`      | 初回移行と互換配信用のlegacyデータ                                            |
| バックアップR2   | `KF3_NOTIF_BACKUP/daily/...`                       | current更新直前の累積アーカイブ                                               |
| バックアップR2   | `KF3_NOTIF_BACKUP/monthly/...`                     | 各月最初の正常実行時点の本番反映済みアーカイブ                                |
| Workers KV       | `KF3_NOTIF_CACHE`の`kf3-news`                      | APIが返す表示用snapshot                                                       |
| Queue            | `kf3-notif-archive-update`                         | refreshのmerge差分またはcurrent初期化を別invocationのarchive更新へ委譲        |
| refresh制御      | R2のCAS leaseとcooldown metadata                   | refreshの同時実行と連続実行を制限                                             |
| 監視             | `HEALTHCHECKS_PING_URL`                            | scheduledの開始、成功、失敗を通知し、Queue consumerへは通知しない任意のsecret |

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

各項目は保存時と復元時に次の条件を満たす必要がある。通常のGET、refresh、Queue consumer、scheduled fallbackで保存済みアーカイブを読む際は、JSON構造、必須フィールドの型、正のID、ID一意性を検証する。

| フィールド  | 条件                                               |
| ----------- | -------------------------------------------------- |
| `id`        | 正の整数。文書内で一意                             |
| `targetUrl` | 空でない文字列                                     |
| `title`     | 空でない文字列                                     |
| `newsDate`  | `yyyy年MM月dd日 HH時mm分ss秒`形式の実在するJST日時 |
| `updated`   | 文字列                                             |
| `category`  | 省略可能な文字列                                   |

公式サイト側の項目追加に追従できるよう、保存用データでは未知フィールドを保持する。GETのクライアント用投影では、`targetUrl`、`title`、`newsDate`、`updated`と、存在する場合の`category`だけを返す。

## 公式データとETag

公式サーバーのお知らせデータ形式とHTTP ETagの契約は [公式お知らせ配信仕様](./official-news-spec.md) にまとめる。Queue consumerとscheduled fallbackはこの外部契約を使って条件付き取得を行い、公式ETag stateを更新する。refreshは公式データを取得して表示用データを作り、条件付き取得を利用できる場合もあるが、公式ETag stateを更新しない。ETag stateの保存と条件付き取得は [お知らせアーカイブETag条件付き取得の実装仕様](./news-archive-etag-optimization.md) を参照する。

## 公式データ利用時の安全性検証

Queue consumer、scheduled fallback、refreshが公式データを採用する際は、公式配信元の契約とは別に、Worker側で次の安全性検証を行う。

| 定数                               | 現在値             | 制約                       | 目的                             |
| ---------------------------------- | ------------------ | -------------------------- | -------------------------------- |
| `MAX_OFFICIAL_RESPONSE_BYTES`      | `10 * 1024 * 1024` | レスポンス本文の最大サイズ | 異常に大きい応答を早期に停止する |
| `OFFICIAL_FETCH_TIMEOUT_MS`        | `10_000`           | 公式レスポンス取得時間     | 停止した応答を失敗として扱う     |
| `MIN_OFFICIAL_ENTRY_COUNT`         | `1_900`            | 公式データの最小件数       | 部分取得や大幅な欠落を検知する   |
| `MAX_UPDATED_EXISTING_ENTRY_COUNT` | `100`              | 変更できる既存IDの最大数   | 大量改変を検知する               |

さらに、次を確認する。

- HTTPステータスが成功で、本文が存在する。
- `Content-Length`がある場合は数字だけの10進整数として解釈でき、10 MiB以下である。
- 本文をストリームで読みながら実バイト数を数え、10 MiBを超えた時点で読み込みを中止する。
- JSONの基本構造、必須フィールドの型、IDの正の整数、一意性を検証する。
- 公式データの新規または変更項目だけ、`targetUrl`が`/`で始まる公式サイト内の相対パスであることを検証する。
- 公式データの新規または変更項目だけ、`newsDate`が厳密な形式と実在する日時を満たすことを検証する。
- 公式データの既存IDに対する変更件数が100件を超えない。

Queue consumerまたはscheduled fallbackで検証に失敗した場合は、R2とKVを変更せず処理全体を失敗させる。Queue consumerはmessageをackせず60秒後にretryする。refreshで検証に失敗した場合は、表示用KVを変更せず503を返す。GETは公式データを扱わないため、この公式取得検証を実行しない。

## 復元仕様

復元機能は本番Workerの公開APIではない。`wrangler.restore.toml`でlocalhost専用Workerを起動し、remote binding経由で本番R2とKVを操作する。復元Worker自体はデプロイしない。実際の操作手順は [お知らせアーカイブ条件付き復元runbook](./news-archive-restore-runbook.md) を参照する。

復元APIは`POST http://127.0.0.1:8790/restore`で、`daily/...json`または`monthly/...json`のsnapshotだけを受け付ける。日次キーは`daily/YYYY/MM/DD/<filename>.json`、月次キーは`monthly/YYYY-MM.json`に限定し、日次の`filename`には英数字、ピリオド、アンダースコア、ハイフンだけを許可する。request URLのhostnameが`localhost`、`127.0.0.1`、`[::1]`のいずれでもない場合は拒否する。

### dry-run

`mode`を省略するか`dry-run`を指定すると、次を検証して表示するだけで書き込みは行わない。

- snapshotの保存用スキーマ、全日付、ID一意性
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

運用手順として、applyでは直前のdry-runで確認した`snapshotDigest`と`currentEtag`を再入力する。復元Workerはdry-runの実行履歴、セッション、確認トークンを保存しない。apply時にsnapshotとcurrentを再度読み、入力値がその時点のdigestとETagに一致することを確認する。

```json
{
  "mode": "apply",
  "snapshotKey": "daily/YYYY/MM/DD/<snapshot>.json",
  "snapshotDigest": "<dry-runで確認したdigest>",
  "currentEtag": "<dry-runで確認したETag>"
}
```

apply時にもsnapshotと現在のETagを再検証する。digestまたはETagが一致しない場合は何も変更しない。currentにはsnapshotの元のバイト列ではなく、検証時に生成した正規化JSONを書き込む。currentは`etagMatches`条件付きで更新し、競合時に無条件更新へ切り替えない。current更新に成功した後だけKVの`kf3-news`を削除する。

KV削除に失敗した場合は、currentがすでに復元済みであることが分かるよう更新後ETagをエラーレスポンスに含める。restoreはrefresh制御metadataを変更しない。

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

## 運用上の境界

- 永続archiveの通常更新はQueue consumerまたはscheduled fallbackの`updateNewsArchive`が行う。
- refreshは表示用KVへ保存し、merge差分がある場合またはcurrentが未作成の場合はQueueへbest-effortで通知する。Queue送信失敗でもHTTP 200を返す。
- Queue consumerはbatch size 1、concurrency 1、失敗時のretry delay 60秒で運用し、heartbeatを送信しない。
- refreshは公開routeだが、R2 CAS lease、5分cooldown、Cloudflare Rate Limiting、WAFで保護する。
- GETから公式取得を開始しない。`waitUntil`でrefresh処理を継続しない。
- `archive/current.json`を公開routeから直接返さない。
- legacyデータ、daily snapshot、monthly snapshotを削除または上書きしない。
- CloudflareのRate LimitingとWAFの推奨運用は [お知らせアーカイブ導入状態](./news-archive-rollout.md) を参照する。
