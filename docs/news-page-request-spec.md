# お知らせページリクエスト仕様

## この文書の責務

本書は、ページ表示と表示用お知らせAPIの仕様を定義する。`GET /`はStatic AssetsからSSG済みshellを返し、Workerを起動せず、お知らせ取得も行わない。ブラウザはHTML解析中に`GET /api/kf3-news`のpreloadを開始し、hydration後のIslandがその結果を利用する。必要に応じて`POST /api/kf3-news/refresh`を別リクエストとして呼び出す。

表示用APIは永続archiveを更新しない。`archive/current.json`、daily、monthly、公式ETag stateはQueue consumerまたは03:15 JSTのscheduled fallbackが更新する。refreshは表示用KVとrefresh制御metadataだけを変更し、merge差分がある場合またはcurrentが未作成の場合はQueueへbest-effortで通知する。保存形式と共通契約は [お知らせ機能共通仕様](./news-spec.md)、永続archive更新は [お知らせアーカイブ更新仕様](./news-archive-update-spec.md) を参照する。

## `GET /`

`GET /`はお知らせ検索UIのSSG済みshellをStatic Assetsから返す。Workerを起動せず、お知らせ配列の取得、公式サーバーへのアクセス、R2 snapshotの読み込み、KVへの書き込みは行わない。日付入力の終了日はHTMLへbuild日時として埋め込まず、hydration後にブラウザの日本時間で設定する。

お知らせデータはshellのHTML解析中にpreloadを開始する別HTTPリクエストで取得し、hydration後のIslandがその結果を利用する。shellの応答とデータ取得のCPU時間を同じリクエストへ合算しない。GETからrefreshを開始したり、`waitUntil`でデータ取得を継続したりしない。

## `GET /api/kf3-news`

### 成功レスポンス

`GET /api/kf3-news`の成功レスポンスはトップレベルのJSON配列とする。まずmerged結果用KV `kf3-news`を読み、値がない場合はGET専用のsnapshot KV `kf3-news-archive-snapshot`を読み込む。両方に値がない場合はR2 snapshotを投影してレスポンスJSONを作成し、同じJSON文字列を直接返す。snapshot KVへのwrite-throughとETag fenceはレスポンス返却後のbest-effort cache maintenanceとして実行する。

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
- `X-KF3-News-Fetched-At`

### KV hit

1. KVの`kf3-news`を`getWithMetadata`で読み込む。
2. 値が存在すれば、保存済みのJSON配列を本文へ返す。
3. R2、公式サーバー、refresh制御metadataへアクセスしない。
4. metadataがあればレスポンスヘッダーへ変換する。metadataがない旧形式のKV valueや不正なmetadataでも、お知らせ配列を壊さずsource不明、取得日時不明として返す。

KV hitから公式データ取得の失敗や`archive-fallback`を推測してはならない。

### archive snapshot KV hit

merged結果用KVに値がない場合、GET専用KV `kf3-news-archive-snapshot`に値があればR2へアクセスせず、そのJSONを返す。metadataはレスポンスヘッダーへ投影する。merged結果用KVを上書きしないため、遅延したGETのsnapshot保存がrefresh結果を置き換えることはない。current更新またはrestore成功時にはこのsnapshot KVを削除する。

### KV miss

両方の表示用KVに値がない場合は、公式データを取得せず、R2のsnapshotをクライアント用配列へ投影する。

1. `archive/current.json`を読み、保存用スキーマを検証する。
2. currentが存在しない場合だけlegacy `entries_merged_20241107.json`を読む。
3. currentが存在するもののJSONまたは内容が不正な場合はlegacyへフォールバックせず、異常として扱う。
4. 検証済みsnapshotをクライアント用配列へ投影し、JSON.stringifyを1回だけ実行する。ここまでがレスポンスcritical pathである。
5. 同じJSON文字列からHTTP 200レスポンスを作成して返す。
6. レスポンス返却後、`executionCtx.waitUntil()`で同じJSON文字列をGET専用KV `kf3-news-archive-snapshot`へTTL 300秒、metadata付きでbest-effort保存する。保存後にcurrentのETagをHEADで再確認し、読み込み時と異なる場合は保存したsnapshotを削除する。KV保存、競合確認、競合時の削除に失敗してもHTTP 200を変更しない。

metadataは`version: 2`、`source: "archive-snapshot"`、`fetchedAt`、`baseArchiveEtag`、`newsCount`を含む。legacy snapshotでは`baseArchiveEtag`を`null`とする。

R2 snapshotを読み込めない場合、または保存用スキーマの検証に失敗した場合はHTTP 500を返す。公式サーバーへのfallback取得やmergeは行わない。KV write-throughが失敗してもHTTP 200を維持し、`news_api_cache_write_failed`だけを記録する。

```json
{
  "error": "お知らせデータの取得に失敗しました"
}
```

GETのR2 snapshot、KV読み込み、またはレスポンス生成の失敗は`news_api_error`として記録する。`waitUntil()`内のGET write-throughまたは競合確認の失敗はHTTP成功を維持し、`news_api_cache_write_failed`として記録する。保存後の競合削除自体に失敗した場合は`news_api_cache_cleanup_failed`として記録する。GETは`news_api_fallback`を記録しない。refreshの失敗は`news_refresh_failed`として記録する。

## `POST /api/kf3-news/refresh`

refreshは、表示用データを最新化する公開APIである。公式データの取得、公式レスポンスの検証、currentまたはlegacyとのmerge、クライアント用配列への投影、KV保存を同じrefreshリクエストで完了する。merge差分がある場合またはcurrentが未作成の場合は、永続archive更新を別invocationへ委譲するQueue messageをbest-effortで送信する。

refresh成功時は、保存した表示用配列と表示用metadataを`{ "news": [...], "metadata": { ... } }`形式で本文へ返す。refreshは`archive/current.json`、legacy、daily、monthly、公式ETag stateを更新しない。保存済みstateとcurrent ETagが対応する場合は条件付き公式取得を利用できる。公式が304を返し、表示用KV metadataがv2かつ`baseArchiveEtag`とcurrent ETagが一致する場合は、KVのJSON文字列をR2 currentの本文処理なしで再利用する。一致しない場合はcurrentをETag条件付きで読み込む従来経路へfallbackする。refreshから条件付き取得状態を保存せず、Queue consumerまたはscheduled fallbackのETag最適化状態へ影響を与えない。merge差分またはcurrent未作成を通知するQueue送信に失敗しても、refreshのKV保存とHTTP 200を維持する。

### refresh制御

refreshはR2のCAS leaseと5分cooldownで制限する。

1. 制御metadataをR2から読み、CAS条件付きPUTでleaseを取得する。
2. lease取得競合時は別refreshが実行中として扱い、公式取得を開始しない。
3. lease取得後、最後の成功refreshから5分未満の場合はcooldownとして拒否し、公式取得を開始しない。
4. 公式取得、検証、mergeの完了後、KV finalization前に同じtokenのleaseをCASで5分間へ延長する。延長できない場合はKVへ書き込まず202を返す。
5. KV保存とcurrent ETag確認が完了したらleaseを解放し、成功時刻を制御metadataへCAS保存する。
6. 公式取得またはKV保存に失敗した場合もleaseを解放する。失敗したrefreshはcooldownを開始しない。
7. leaseとcooldownの判定、取得、延長、解放はCASで行い、無条件上書きに切り替えない。

制御metadataの内容は表示用KVやarchiveの内容と混同せず、公式ETag stateとして利用しない。refreshの同時実行、cooldown、制御metadataのCAS失敗はHTTP契約へ変換する。

### HTTP契約

| HTTP | 条件                                                                                                   | 動作                                           |
| ---: | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
|  202 | refreshが実行中、または実行中にleaseが失効し、成功結果を確定できない                                   | 他refreshのKVを削除せず、`Retry-After`を付ける |
|  200 | lease取得済みでrefreshを実行し、公式取得、検証、merge、KV保存に成功した。Queue送信失敗は成功を妨げない | `{news, metadata}`を本文で返す                 |
|  429 | 最後の成功から5分未満                                                                                  | 公式取得を開始せず、`Retry-After`を付ける      |
|  503 | R2 lease、制御metadata、公式取得、検証、merge、KV保存などの依存処理に失敗した                          | 表示用KVとarchiveを変更せずエラーを返す        |
|  405 | POST以外でrefresh endpointを呼び出した                                                                 | `Allow: POST`を返す                            |

200レスポンスの本文は、次の`{news, metadata}`オブジェクトとする。`news`は表示用のお知らせ配列、`metadata`はcache metadataの`version`、`source`、`fetchedAt`、`baseArchiveEtag`、`newsCount`を含む。GETだけが成功時にトップレベル配列を返す。

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
    "fetchedAt": "2026-08-12T12:34:56.789Z",
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
5. 同じtokenのrefresh leaseをCASで5分間へ延長し、KV finalization中に別refreshがleaseを取得できないようにする。延長できない場合はKVへ書き込まず202を返す。
6. 表示用KV `kf3-news`へ`clientJson`をTTL 300秒で保存し、metadataの`version`を2、`source`を`merged`、`fetchedAt`をrefresh成功時刻、`newsCount`を配列件数として記録する。統合結果がcurrentの正確な投影である場合だけ`baseArchiveEtag`へcurrent ETagを記録し、それ以外は`null`とする。
7. KV保存後にcurrent ETagとrefresh leaseを再確認する。archive更新と競合していた場合は保存したKVを削除し、Queueへ通知せず503を返す。leaseが失効または別tokenへ移行していた場合は、次refreshのKVを削除しないよう共有キーを変更せず202を返す。
8. refresh leaseを成功として完了する。完了時にtoken不一致となった場合も共有KVを削除せず202を返す。
9. merge差分がある場合またはcurrentが未作成の場合は`kf3-notif-archive-update` Queueへmessageをpublishする。送信失敗はログへ記録するが、KV保存を取り消さずHTTP 200を返す。
10. `clientJson`を再シリアライズせずmetadataだけをJSON化し、保存したJSONを`{news, metadata}`形式の200本文へ埋め込む。

公式取得、検証、merge、KV保存のいずれかに失敗した場合、refreshはKVを置き換えず503を返す。Queue送信だけが失敗した場合は、表示用KVを保持したまま`news_archive_update_enqueue_failed`へ記録し、refreshは200を返す。refreshはarchive-fallbackを成功結果として返さない。古い表示を返す必要がある場合は、別途GETで既存KV snapshotを取得する。

### refreshが行わないこと

- `archive/current.json`の更新。merge差分またはcurrent未作成のQueue publishだけを行い、archive更新はQueue consumerへ委譲する
- dailyまたはmonthlyの作成、更新、削除
- 公式ETag stateの保存、更新、削除
- refresh制御metadata以外のR2書き込み
- 通常の成功経路でのKV `kf3-news`削除。current競合後の書き込みcleanupでは削除するが、leaseまたはtoken不一致では他refreshのKVを保護するため削除しない
- GETリクエストからの公式取得
- `waitUntil`によるrefresh処理の継続

## archive更新との分離

永続archiveを確定する処理は、refreshと別invocationで動くQueue consumerまたは03:15 JSTのscheduled fallbackが、同じ`updateNewsArchive`を実行して担当する。Queue consumerは`trigger=queue`、scheduled handlerは`trigger=scheduled`を渡す。Queue consumerはheartbeatを送らず、batch size 1、concurrency 1、失敗時は60秒後にretryする。Queue consumerはrefreshで作った表示用KVを維持し、scheduled fallbackはcurrentを更新したときに表示用KVを削除する。

archive更新の詳細は [お知らせアーカイブ更新仕様](./news-archive-update-spec.md)、ETag stateと304経路の共通設計は [お知らせアーカイブETag条件付き取得の実装仕様](./news-archive-etag-optimization.md) を参照する。

## 互換route

互換性維持のため、`GET /entries_merged_20241107.json`と`HEAD /entries_merged_20241107.json`も残す。このrouteはR2オブジェクトを保存用スキーマで検証せず、そのバイト列をそのまま返す。レスポンスには1年間のimmutable cache指定と、取得できた場合はR2のHTTP ETagを付ける。

legacy objectが存在しない場合、またはR2から取得できない場合は5xxとする。`archive/current.json`は公開しない。
