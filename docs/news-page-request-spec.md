# お知らせページリクエスト仕様

## この文書の責務

本書は、ページ表示と表示用お知らせAPIの仕様を定義する。`GET /`はStatic AssetsからSSG済みshellを返し、Workerを起動せず、お知らせ取得も行わない。ブラウザはHTML解析中に`GET /api/kf3-news`のpreloadを開始し、hydration後のIslandがその結果を利用する。必要に応じて`POST /api/kf3-news/refresh`を別リクエストとして呼び出す。

表示用APIは永続archiveを更新しない。`archive/current.json`、daily、monthly、公式ETag stateはQueue consumerまたは03:15 JSTのscheduled fallbackが更新する。公式確認時刻は独立した`official-check-state`へ、refresh、Queue consumer、scheduled fallbackの公式確認成功時に保存する。refreshは表示用KVの本文と可変state、`KF3_REFRESH_COORDINATOR` Durable Objectのstateを変更し、R2の公式確認時刻stateはレスポンス後にbest-effortで更新する。merge差分がある場合またはcurrentが未作成の場合はQueueへbest-effortで通知する。保存形式と共通契約は [お知らせ機能共通仕様](./news-spec.md)、永続archive更新は [お知らせアーカイブ更新仕様](./news-archive-update-spec.md) を参照する。

## `GET /`

`GET /`はお知らせ検索UIのSSG済みshellをStatic Assetsから返す。Workerを起動せず、お知らせ配列の取得、公式サーバーへのアクセス、R2 snapshotの読み込み、KVへの書き込みは行わない。日付入力の終了日はHTMLへbuild日時として埋め込まず、hydration後にブラウザの日本時間で設定する。

お知らせデータはshellのHTML解析中にpreloadを開始する別HTTPリクエストで取得し、hydration後のIslandがその結果を利用する。shellの応答とデータ取得のCPU時間を同じリクエストへ合算しない。GETからrefreshを開始したり、`waitUntil`でデータ取得を継続したりしない。

## `GET /api/kf3-news`

### 成功レスポンス

`GET /api/kf3-news`の成功レスポンスはトップレベルのJSON配列とする。まずmerged結果用KV `kf3-news`と可変state用KV `kf3-news-refresh-state`を並列に読み、本文metadataの`baseArchiveEtag`とstateが一致する場合だけ公式確認時刻とcooldown終了時刻を合成する。本文がない場合はGET専用のsnapshot KV `kf3-news-archive-snapshot`を読み込む。両方の本文KVに値がない場合はR2 snapshotを投影してレスポンスJSONを作成し、同じJSON文字列を直接返す。snapshot KVへのwrite-throughとETag fenceはレスポンス返却後のbest-effort cache maintenanceとして実行する。

```json
[
  {
    "targetUrl": "/info/detail/1234567890.html",
    "title": "お知らせのタイトル",
    "newsDate": "2026年08月02日 12時00分00秒",
    "updated": "",
    "category": "お知らせ"
  }
]
```

レスポンスには`targetUrl`、`title`、`newsDate`、`updated`を必須フィールドとして含め、保存用データに`category`がある場合だけ任意フィールドとして含める。`id`やその他の未知フィールドはクライアントへ返さない。

`category`がない、空文字、空白だけの場合、UIは分類ラベルを表示しない。`category`はカンマで分割し、値ごとに異なる背景色のラベルとして表示する。`【サイト】アプリ`は`アプリ`として表示し、`【サイト】`は表示しない。

APIはsnapshotの入力順を維持して返す。日付順への並べ替えは画面側で行う。KV metadataは次のレスポンスヘッダーへ投影する。

- `X-KF3-News-Source`
- `X-KF3-News-Official-Checked-At`
- `X-KF3-News-Refresh-Available-At`（refresh成功時に保存した可変state KVからも返す）
- `X-KF3-News-Data-Version`（v2 metadataが正確な`merged`または`archive-snapshot`の場合だけ）

### KV hit

1. KVの`kf3-news`と`kf3-news-refresh-state`を並列に読み込む。
2. 本文が存在すれば、保存済みのJSON配列を返す。本文metadataと可変stateの`baseArchiveEtag`が一致する場合だけstateをレスポンスmetadataへ合成する。
3. R2、公式サーバー、refresh制御stateへアクセスしない。
4. metadataがない旧形式のKV valueや不正なmetadataでも、お知らせ配列を壊さずsource不明、取得日時不明として返す。不正または本文と不一致の可変stateは無視する。

KV hitから公式データ取得の失敗や`archive-fallback`を推測してはならない。

### archive snapshot KV hit

merged結果用KVに値がない場合、GET専用KV `kf3-news-archive-snapshot`に値があればR2へアクセスせず、そのJSONを返す。本文metadataと可変refresh stateの`baseArchiveEtag`が一致する場合はstateを合成してレスポンスヘッダーへ投影する。merged結果用KVを上書きしないため、遅延したGETのsnapshot保存がrefresh結果を置き換えることはない。current更新またはrestore成功時にはこのsnapshot KVを削除する。

### KV miss

両方の表示用KVに値がない場合は、公式データを取得せず、R2のsnapshotをクライアント用配列へ投影する。

1. `archive/current.json`を読み、保存用スキーマを検証する。
2. currentが存在しない場合だけlegacy `entries_merged_20241107.json`を読む。
3. currentが存在するもののJSONまたは内容が不正な場合はlegacyへフォールバックせず、異常として扱う。
4. 検証済みsnapshotをクライアント用配列へ投影し、JSON.stringifyを1回だけ実行する。ここまでがレスポンスcritical pathである。
5. 同じJSON文字列からHTTP 200レスポンスを作成して返す。
6. レスポンス返却後、`executionCtx.waitUntil()`で同じJSON文字列をGET専用KV `kf3-news-archive-snapshot`へTTL 86400秒、state適用後のmetadata付きでbest-effort保存する。保存後にcurrentのETagをHEADで再確認し、読み込み時と異なる場合は保存したsnapshotを削除する。KV保存、競合確認、競合時の削除に失敗してもHTTP 200を変更しない。

metadataは`version: 2`、`source: "archive-snapshot"`、`officialCheckedAt`、`baseArchiveEtag`、`newsCount`を含む。公式確認時刻は独立した`archive/official-check-state.json`から復元し、stateが利用できない場合は`officialCheckedAt`を`null`とする。対応する`kf3-news-refresh-state`が存在し、`baseArchiveEtag`が一致する場合は、refresh stateの`officialCheckedAt`と`refreshAvailableAt`を優先する。legacy snapshotでは`baseArchiveEtag`を`null`とする。

R2 snapshotを読み込めない場合、または保存用スキーマの検証に失敗した場合はHTTP 500を返す。公式サーバーへのfallback取得やmergeは行わない。KV write-throughが失敗してもHTTP 200を維持し、`news_api_cache_write_failed`だけを記録する。

```json
{
  "error": "お知らせデータの取得に失敗しました"
}
```

GETのR2 snapshot、KV読み込み、またはレスポンス生成の失敗は`news_api_error`として記録する。`waitUntil()`内のGET write-throughまたは競合確認の失敗はHTTP成功を維持し、`news_api_cache_write_failed`として記録する。保存後の競合削除自体に失敗した場合は`news_api_cache_cleanup_failed`として記録する。GET成功時は`news_api_succeeded`として、`dataSource`、`primaryCacheReadDurationMs`、`refreshStateReadDurationMs`、`snapshotCacheReadDurationMs`、`archiveReadDurationMs`、`officialCheckStateReadDurationMs`、`totalDurationMs`、`workerVersionId`を記録する。GETは`news_api_fallback`を記録しない。refreshの失敗は`news_refresh_failed`として記録する。

## `POST /api/kf3-news/refresh`

refreshは、表示用データを最新化する公開APIである。公式データの取得、公式レスポンスの検証、currentまたはlegacyとのmerge、クライアント用配列への投影、KV保存を同じrefreshリクエストで完了する。merge差分がある場合またはcurrentが未作成の場合は、永続archive更新を別invocationへ委譲するQueue messageをbest-effortで送信する。

refresh成功時は、保存した表示用配列と表示用metadataを本文へ返す。通常は`{ "news": [...], "metadata": { ... } }`形式とし、リクエストの`X-KF3-News-Data-Version`が今回の表示データと一致する場合だけ`{ "changed": false, "metadata": { ... } }`形式で`news`を省略する。refreshは`archive/current.json`、legacy、daily、monthly、公式ETag stateを更新しない。表示用KVは本文`kf3-news`と可変state`kf3-news-refresh-state`へ分離し、Durable Objectのrefresh制御stateを同期更新する。R2の公式確認時刻stateは成功レスポンスを待たせず`waitUntil()`で更新する。保存済みstateとcurrent ETagが対応する場合は条件付き公式取得を利用できる。公式が304を返し、表示用KV metadataがv2かつ`baseArchiveEtag`とcurrent ETagが一致する場合は、KVのJSON文字列をR2 currentの本文処理なしで再利用する。この経路では本文KVを再保存せず、post-writeのcurrent HEADも行わない。一致しない場合はcurrentをETag条件付きで読み込む従来経路へfallbackする。refreshから条件付き取得状態を保存せず、Queue consumerまたはscheduled fallbackのETag最適化状態へ影響を与えない。merge差分またはcurrent未作成を通知するQueue送信に失敗しても、refreshのKV保存とHTTP 200を維持する。

クライアントはGETレスポンスの`X-KF3-News-Data-Version`を保持し、refresh時に同じヘッダーで送信する。ヘッダーがない場合、または今回の表示データと一致しない場合は、refreshは通常どおり`news`全件を返す。`changed:false`を受け取ったクライアントは保持中の配列をそのまま使い、metadataだけを更新する。画面の「最終取得」とstale判定は`officialCheckedAt`を使い、refresh後のcooldown判定は`refreshAvailableAt`を使う。refresh成功時に可変state KVへ保存した`refreshAvailableAt`はGETのKV hitでも返し、クライアントはその値でボタンを無効化する。値がない旧形式のKVでは、クライアントはローカルの推定値でボタンを無効化せず、refresh APIの制御結果に従う。

### refresh制御

refreshは`KF3_REFRESH_COORDINATOR` Durable ObjectのSQLite stateと5分cooldownで制限する。Coordinator名は`kf3-news`で固定し、1つのお知らせフィード全体を1つのcoordination単位として扱う。

1. `getByName("kf3-news")`でCoordinatorを取得し、`acquire(nowMs)` RPCを呼び出す。
2. Coordinator内でrunningと有効なcooldownを判定し、実行中またはcooldown中なら公式取得を開始しない。
3. acquire成功時はtokenとlease期限をDO stateへ保存し、呼び出し元へleaseを返す。
4. 公式取得、検証、mergeの完了後、KV finalization前にleaseの残り時間が20秒未満の場合だけ、`renew(token, nowMs, leaseMs)` RPCで5分間へ延長する。延長できない場合はKVへ書き込まず202を返す。
5. 表示用KV保存と必要なcurrent ETag確認が完了したら、`complete(token, "success", nowMs)` RPCでtokenとlease期限を検証してcooldownへ遷移する。
6. 公式取得またはKV保存に失敗した場合は`complete(token, "failure", nowMs)` RPCでidleへ戻す。失敗したrefreshはcooldownを開始しない。
7. DO stateは初回bootstrap時だけ既存R2の`control/news-refresh.json`から引き継ぐ。bootstrap後はR2 controlを読み書きせず、CoordinatorのStorageだけを正本として扱う。

Coordinatorのstateは表示用KV、archive、公式ETag stateと分離する。refreshの同時実行、cooldown、RPCまたはstate保存の失敗はHTTP契約へ変換する。

### HTTP契約

| HTTP | 条件                                                                                                   | 動作                                                                                                   |
| ---: | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
|  202 | refreshが実行中、または実行中にleaseが失効し、成功結果を確定できない                                   | 他refreshのKVを削除せず、`Retry-After`を付ける                                                         |
|  200 | lease取得済みでrefreshを実行し、公式取得、検証、merge、KV保存に成功した。Queue送信失敗は成功を妨げない | `X-KF3-News-Data-Version`一致時は`{changed:false, metadata}`、それ以外は`{news, metadata}`を本文で返す |
|  429 | 最後の成功から5分未満                                                                                  | 公式取得を開始せず、`Retry-After`を付ける                                                              |
|  503 | Durable Object RPC、制御state、公式取得、検証、merge、KV保存などの依存処理に失敗した                   | 表示用KVとarchiveを変更せずエラーを返す                                                                |
|  405 | POST以外でrefresh endpointを呼び出した                                                                 | `Allow: POST`を返す                                                                                    |

200レスポンスの本文は、通常は`{news, metadata}`オブジェクトとする。`news`は表示用のお知らせ配列、`metadata`はcache metadataの`version`、`source`、`officialCheckedAt`、`baseArchiveEtag`、`newsCount`を含む。refresh成功時は、公式確認時刻とは別に`refreshAvailableAt`（サーバー側cooldown終了時刻）を含め、可変state用KVにも保存する。リクエストの`X-KF3-News-Data-Version`が`baseArchiveEtag`と一致する場合は、`news`を含めず`{changed:false, metadata}`を返す。GETだけが成功時にトップレベル配列を返す。

```json
{
  "news": [
    {
      "targetUrl": "/info/detail/1234567890.html",
      "title": "お知らせのタイトル",
      "newsDate": "2026年08月02日 12時00分00秒",
      "updated": "",
      "category": "お知らせ"
    }
  ],
  "metadata": {
    "version": 2,
    "source": "merged",
    "officialCheckedAt": "2026-08-12T12:34:56.789Z",
    "refreshAvailableAt": "2026-08-12T12:39:56.789Z",
    "baseArchiveEtag": "current-etag",
    "newsCount": 1
  }
}
```

202レスポンス本文は、別refreshが実行中の場合は`{"error":"お知らせ更新が実行中です","leaseUntil":"..."}`、自身のleaseが失効した場合は`{"error":"お知らせ更新のleaseが失効しました"}`とする。429レスポンス本文は`{"error":"お知らせ更新はクールダウン中です","nextAvailableAt":"..."}`、503レスポンス本文は`{"error":"お知らせ更新に失敗しました"}`とする。

202、429では、再試行可能になるまでの秒数を`Retry-After`で返す。202は別refreshが実行中であり、leaseが期限切れになるまでの待機を示す。429はcooldown残り時間を指定する。503では、固定の短い再試行待ちを指定できる。内部エラー、R2 key、ETag、公式レスポンス本文、secretはレスポンスへ含めない。

### refresh成功時の保存

1. `archive/current.json`を読み、存在しない場合だけlegacyを読む。
2. 公式レスポンスを取得し、HTTPステータス、本文サイズ、JSON構造、必須フィールド、ID一意性、安全性閾値を検証する。
3. 公式データの新規または変更項目を検証し、IDをキーにsnapshotとmergeする。同じIDには公式データを採用し、snapshotにだけ存在するIDは残す。
4. 統合結果をクライアント用配列へ投影し、JSON.stringifyを1回だけ実行して`clientJson`を作る。304 fast pathでは既存KVのJSON文字列を`clientJson`としてそのまま使う。
5. refresh leaseの残り時間が20秒未満の場合だけ、Coordinatorの`renew` RPCで同じtokenのleaseを5分間へ延長する。延長できない場合はKVへ書き込まず202を返す。
6. 新しい本文を作った場合は表示用KV `kf3-news`へ`clientJson`をTTL 86400秒で保存する。本文metadataは`version: 2`、`source: merged`、`baseArchiveEtag`、`newsCount`を保持し、可変時刻は持たない。304で既存KV JSONを再利用した場合は本文を保存しない。
7. 本文を保存した場合だけcurrent ETagを再確認する。archive更新と競合していた場合は保存した本文KVを削除し、Queueへ通知せず503を返す。本文を再利用した304経路では書き込みraceがないため、このHEADを省略する。
8. 可変state用KV `kf3-news-refresh-state`へ`baseArchiveEtag`、`officialCheckedAt`、`refreshAvailableAt`をTTL 86400秒で保存し、同じtokenのleaseが未失効であることを確認して成功完了する。leaseが失効または別tokenへ移行していた場合は、次refreshのKVを削除しないよう共有キーを変更せず202を返す。
9. R2の`archive/official-check-state.json`更新と、必要な`kf3-notif-archive-update` Queue送信を`waitUntil()`へ登録する。失敗はログへ記録するが、確定済みのrefreshレスポンスを変更しない。
10. `clientJson`を再シリアライズせずmetadataだけをJSON化する。クライアントのdata versionが一致する場合は`{changed:false, metadata}`を返し、それ以外は保存済みまたは再利用したJSONを`{news, metadata}`形式の200本文へ埋め込む。

公式取得、検証、merge、同期KV保存のいずれかに失敗した場合、refreshは本文KVを置き換えず503を返す。Queue送信またはR2公式確認時刻state更新が失敗した場合は、表示用KVを維持して失敗をログへ記録し、refreshは200を返す。refreshはarchive-fallbackを成功結果として返さない。古い表示を返す必要がある場合は、別途GETで既存KV snapshotを取得する。

### refreshが行わないこと

- `archive/current.json`の更新。merge差分またはcurrent未作成のQueue publishだけを行い、archive更新はQueue consumerへ委譲する
- dailyまたはmonthlyの作成、更新、削除
- 公式ETag stateの保存、更新、削除
- `official-check-state`以外のR2書き込み
- 公式確認成功時を除く`official-check-state`の更新
- 通常の成功経路での表示用KV削除。current競合後の本文書き込みcleanupでは本文KVを削除するが、leaseまたはtoken不一致では他refreshの本文KVとstate KVを保護するため削除しない
- GETリクエストからの公式取得
- refresh本体の処理を`waitUntil`へ移すこと。Queue送信とR2公式確認時刻state更新だけをレスポンス経路から分離する

## archive更新との分離

永続archiveを確定する処理は、refreshと別invocationで動くQueue consumerまたは03:15 JSTのscheduled fallbackが、同じ`updateNewsArchive`を実行して担当する。Queue consumerは`trigger=queue`、scheduled handlerは`trigger=scheduled`を渡す。Queue consumerはheartbeatを送らず、batch size 1、concurrency 1、失敗時は60秒後にretryする。Queue consumerはrefreshで作った本文KVとstate KVを維持し、scheduled fallbackはcurrentを更新したときに表示用KVを削除する。

archive更新の詳細は [お知らせアーカイブ更新仕様](./news-archive-update-spec.md)、ETag stateと304経路の共通設計は [お知らせアーカイブETag条件付き取得の実装仕様](./news-archive-etag-optimization.md) を参照する。

## 互換route

互換性維持のため、`GET /entries_merged_20241107.json`と`HEAD /entries_merged_20241107.json`も残す。このrouteはR2オブジェクトを保存用スキーマで検証せず、そのバイト列をそのまま返す。レスポンスには1年間のimmutable cache指定と、取得できた場合はR2のHTTP ETagを付ける。

legacy objectが存在しない場合、またはR2から取得できない場合は5xxとする。`archive/current.json`は公開しない。
