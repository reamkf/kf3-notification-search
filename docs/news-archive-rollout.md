# お知らせアーカイブ導入状態

## 導入対象

本番Workerは次の処理を提供する。

- `GET /`はStatic Assetsからお知らせ取得を行わないSSG済みshellを返す。
- `GET /api/kf3-news`はmerged結果用KVを最優先し、値がない場合はGET専用snapshot KVを返す。両方のKV miss時はR2のcurrentまたはlegacy snapshotを投影してGET専用KVへwrite-throughする。
- `POST /api/kf3-news/refresh`は公式データを取得、検証、mergeし、成功結果を表示用KVへ保存する。`X-KF3-News-Data-Version`が一致する場合は`{changed:false, metadata}`、それ以外は`{news, metadata}`形式で200を返す。merge差分がある場合またはcurrentが未作成の場合は`kf3-notif-archive-update` Queueへbest-effortで通知し、送信失敗でも200を返す。実行中は202、cooldownは429、依存障害は503を返す。
- refreshは`KF3_REFRESH_COORDINATOR` Durable ObjectのSQLite stateと5分cooldownで制限し、Cloudflare Rate LimitingとWAFで公開routeを保護する。
- refresh invocation自身は表示用KV、公式確認時刻state、Durable Objectのrefresh制御stateを変更し、current、daily、monthly、公式ETag stateを書き込まない。
- Queue consumerは別invocationで同じ`updateNewsArchive`を`trigger=queue`として実行し、scheduledの`updateNewsArchive`は03:15 JSTのfallbackとして`trigger=scheduled`で実行する。両方がcurrent、daily、monthly、公式ETag state、公式確認時刻stateを更新する。
- Queue consumerはheartbeatを送らず、refresh由来の表示KVを維持する。batch size 1、concurrency 1、更新失敗時は60秒後にretryし、重複messageは既存のETag、CAS、304経路で許容する。
- restoreはlocalhost専用Workerとしてsnapshotからcurrentを条件付きで復元する。

共通契約は [お知らせ機能共通仕様](./news-spec.md)、APIは [お知らせページリクエスト仕様](./news-page-request-spec.md)、archive更新は [お知らせアーカイブ更新仕様](./news-archive-update-spec.md)、ETagは [お知らせアーカイブETag条件付き取得の実装仕様](./news-archive-etag-optimization.md) を参照する。

## R2 controlからの切り替え

- この切り替えではgradual deploymentを使わず、新Workerへ100%切り替える。旧WorkerのR2 leaseと新WorkerのDurable Object stateは同じmutexではないため、両方を長時間稼働させない。
- Durable Objectの初回RPCでは、stateがなければ`KF3_NOTIF_DATA/control/news-refresh.json`を読み、期限内のrunningまたはcooldownをSQLiteへbootstrapする。
- R2の`control/news-refresh.json`は切り替え後すぐには削除せず、少なくとも1リリース保持する。bootstrap完了後の通常refreshはR2 controlを参照しない。
- rollback時は旧WorkerがR2 controlを正本として使うため、DO側のleaseまたはcooldown状態とR2側の状態が一致しない可能性を確認する。切り替え直後のrollbackは、refreshの同時実行を避けるため、旧Workerへ戻す前に実行中処理の完了またはlease期限切れを待つ。

## 外部状態の確認項目

本番反映後は、現行Worker version、Cron、R2、KV、`KF3_REFRESH_COORDINATOR` Durable Object、Healthchecks.io、Cloudflare Rate Limiting、WAFの設定を同じ運用記録で確認する。secret、lease token、ETag、公式本文は記録しない。

| 項目                     | 確認内容                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本番Worker               | 現HEADに対応するWorker versionへ反映され、`GET /`、GET、refresh、Queue consumer、scheduled fallbackが有効                                                                                                                                                        |
| Queue                    | `kf3-notif-archive-update`を作成済みで、producerとconsumerが本番Workerに設定され、batch size 1、concurrency 1である                                                                                                                                              |
| HTTP `/`                 | Static AssetsからSSG済みshellだけを返し、レスポンス中にお知らせ配列を含まず、Workerを起動しない                                                                                                                                                                  |
| HTTP GET                 | merged KVを最優先し、次にGET専用snapshot KVを読む。両方のmiss時はR2 currentまたはlegacyを投影してsnapshot KVへwrite-throughし、write失敗でも200を維持する                                                                                                        |
| HTTP refresh             | 実行中は202、成功時は200とし、data version一致時は`{changed:false, metadata}`、それ以外は`{news, metadata}`を返してKVへ同じ表示用データを保存する。304かつKV v2/current ETag一致時はcurrent本文を読まず再利用する。merge差分またはcurrent未作成をQueueへ通知する |
| refresh制御              | Coordinatorの同一DOでleaseを直列化し、実行中は202、5分cooldown中は429、依存障害は503を返す。無条件上書きを行わない                                                                                                                                               |
| refresh書き込み境界      | refresh invocation自身はcurrent、daily、monthly、公式ETag stateを書き込まず、公式確認時刻stateとCoordinator stateだけを更新する。Queue送信失敗でも200を返す                                                                                                      |
| Queue consumer           | 別invocationで`trigger=queue`を実行し、batch size 1、concurrency 1、60秒後retry、heartbeatなし、表示KV維持を確認する                                                                                                                                             |
| Cron Trigger             | `15 18 * * *`を1本だけ登録し、Queueのfallbackとして毎日03:15 JSTに実行される                                                                                                                                                                                     |
| archive update           | Queue consumerとscheduled fallbackが同じETag/CAS/304、CAS更新、daily/monthly backup、公式ETag state保存を行う                                                                                                                                                    |
| ETag                     | Queue consumerとscheduled fallbackの200と304、stateとcurrent ETag不一致時の完全処理を確認する                                                                                                                                                                    |
| Healthchecks.io          | `kf3notif-daily-archive`をUTC `15 18 * * *`、grace 30分で運用し、失敗とCron欠落を通知する                                                                                                                                                                        |
| Cloudflare Rate Limiting | refresh routeを対象に、通常利用を許容しつつ短時間の反復POSTを抑制する。429応答と適用範囲を確認する                                                                                                                                                               |
| Cloudflare WAF           | refresh routeにManaged Rulesと必要なカスタムルールを適用し、異常な自動化、明らかな攻撃、想定外のmethodを遮断する。正規refreshの誤検知を確認する                                                                                                                  |
| restore                  | localhost専用Workerをdeployせず、dry-runがR2とKVへ書き込まない                                                                                                                                                                                                   |

## refresh運用ポリシー

refreshは公開APIであり、アプリケーション内のDurable Object leaseと5分cooldownを必須の制御として扱う。Cloudflareのエッジ制御はアプリケーション制御の代替ではない。

### Cloudflare Rate Limitingの推奨

- 対象は`POST /api/kf3-news/refresh`に限定する。
- 送信元IPを基準に、短時間の反復POSTを抑制する。通常のUI操作と、複数クライアントからの同時refreshを分けて観測できる閾値から開始する。
- originの429契約を尊重し、Rate Limitingによる拒否も429としてクライアントへ伝わることを確認する。
- GET `/api/kf3-news`や`GET /`をrefresh用の厳しい制限へ巻き込まない。
- Workers LogsとRate Limiting eventで、許可数、429数、送信元分布、誤検知を確認し、利用状況に応じて閾値を調整する。

### WAFの推奨

- Managed Rulesを有効化し、Workers APIを対象とした明らかな攻撃パターンを遮断する。
- refresh routeへ、POST以外を拒否するcustom rule、想定外に大きいrequest bodyを拒否するcustom rule、明らかな自動化や異常な送信元をchallengeまたはblockするcustom ruleを検討する。
- API本文を検査するルールでは、正規JSONのrefreshを誤検知しないことを確認する。WAFがbodyを許可しても、アプリケーションのJSON検証、公式データ検証、Durable Object leaseを省略しない。
- WAFのblock、challenge、skipの変更は、refreshの200、202、429、503契約とWorkers Logsのイベントを突き合わせて確認する。

## 受け入れ条件

- [ ] `GET /`がStatic Assetsからお知らせ取得なしのSSG済みshellを返し、Workerを起動しない。
- [ ] GETのKV hitがKVだけで完了する。
- [ ] current更新時にGET専用snapshot KVを削除し、Queueではmerged KVを維持する。
- [ ] merged KVとGET専用snapshot KVの両方がmissした場合、R2 currentまたはlegacyを投影し、同じJSONをTTL 86400秒でsnapshot KVへwrite-throughする。write失敗でも200を維持し、公式取得とmergeを行わない。
- [ ] refresh実行中が202と`Retry-After`を返し、成功時は200とし、data version一致時は`{changed:false, metadata}`、それ以外は`{news, metadata}`を返して表示用KVへ保存する。
- [ ] refreshのcooldownが429と`Retry-After`を返す。
- [ ] KV finalization前にrefresh leaseの残り時間が20秒未満の場合だけ、Coordinatorの`renew` RPCで5分間へ延長し、延長できない場合はKVへ書き込まず202を返す。
- [ ] KV保存中にrefresh leaseが失効または別tokenへ移行した場合は、他refreshのKVを削除せず、Queueへ通知せず202を返す。
- [ ] refreshのR2、公式、検証、merge、KV保存の依存障害が503を返す。
- [ ] refreshがcurrent、daily、monthly、公式ETag stateを変更せず、公式確認時刻stateを更新する。
- [ ] currentが存在し、merge差分がないrefreshはQueue messageを生成しない。
- [ ] merge差分があるrefreshは`refresh-detected-change` messageを1件生成する。
- [ ] current未作成のrefreshはmerge差分が0でも`refresh-current-missing`と`requiresInitialization=true`のmessageを1件生成する。
- [ ] Queue送信失敗でもrefreshは200とKV更新を維持する。
- [ ] 公式304かつKV v2/current ETag一致時はR2 current本文を読まず、同じKV JSONをTTLとmetadataだけ更新して再保存する。
- [ ] Queue consumerが別invocationで同じ`updateNewsArchive`を`trigger=queue`として実行し、成功時にackする。
- [ ] Queue consumer成功後にcurrentへ変更が反映され、公式ETag stateと公式確認時刻stateが更新され、refresh由来の表示KVが維持される。
- [ ] Queue consumerがbatch size 1、concurrency 1、heartbeatなし、失敗時60秒後retryで動作する。
- [ ] Queue consumerとscheduled fallbackが競合してもcurrentを無条件PUTしない。
- [ ] scheduled fallbackはQueueの成否に関係なく毎日03:15 JSTに実行される。
- [ ] refresh、Queue consumer、scheduled fallbackが別invocationとしてCPU時間へ記録される。
- [ ] shell、GET、refresh、scheduled、Queue consumerを別invocationとして確認でき、refreshのQueue送信だけが`waitUntil`へ登録される。
- [ ] 手動操作なしで毎日03:15 JSTにscheduled fallbackが実行される。
- [ ] Healthchecks.ioからCron失敗またはCron欠落の通知を実受信できる。
- [ ] 公式サイトから消えたIDがQueue consumerまたはscheduled fallbackのarchiveに残り、同一IDの更新には公式内容が採用される。
- [ ] 不正取得、閾値超過、日次backup失敗でcurrentとKVが変更されない。
- [ ] ETag競合時にcurrent、KV、monthlyが誤って確定しない。
- [ ] Queue consumerとscheduled fallbackの200と304、stateとcurrent ETag不一致時の完全処理を確認できる。
- [ ] Queue messageの重複配送が既存ETag、CAS、304経路で安全に処理される。
- [ ] Cloudflare Rate Limitingがrefreshの反復POSTを抑制し、正規の利用を不必要に拒否しない。
- [ ] Cloudflare WAFが異常なrefresh requestを遮断し、正規JSONを誤検知しない。
- [ ] 本番snapshotを使ったrestore dry-runでR2とKVへのwriteが0件になる。
- [ ] `news_api_succeeded`、`news_refresh_succeeded`、`news_refresh_failed`を含む構造化ログをWorkers Logsで確認でき、GET成功ログの`dataSource`と各duration、GETとrefreshの`workerVersionId`を確認できる。
- [ ] Workers TracingでGET、refresh、scheduled、Queueのinvocationとfetch、KV、R2 spanを確認できる。
- [ ] Queue consumer、scheduled fallback、GET、refreshのCPU時間を別invocationとして確認できる。

## 障害調査

- shellやGETが遅い場合は、`GET /`と`GET /api/kf3-news`の外部I/O、KV hit率、R2 snapshot読み込みを確認する。GETが公式サーバーへアクセスしていないことを確認する。
- refreshが202の場合はCoordinatorの実行中leaseまたはlease失効理由と`Retry-After`を確認する。429の場合は5分cooldown、`Retry-After`、Cloudflare Rate Limiting eventを確認する。
- refreshが503の場合は、`news_refresh_failed`の`stage`、Durable Object RPC、公式取得、検証、merge、KV保存のどこで失敗したかを確認する。成功時は`news_refresh_succeeded`を確認する。失敗前のKV、current、公式ETag stateが変更されていないことを確認する。
- Queue送信が失敗した場合は`news_archive_update_enqueue_failed`を確認する。refreshの200とKV保存が維持されていることを確認する。
- Queue consumerが失敗した場合は`news_archive_queue_failed`と`news_archive_update_failed`の`stage`、`error`、`details`を確認し、60秒後retryとmessage未ackを確認する。scheduledが失敗した場合も`news_archive_update_failed`を確認する。公式本文、ETag、secretはログへ出力しない。
- 304率やCPU時間を確認するときは、Queue consumerとscheduled fallbackの`trigger`、`officialFetchStatus`別にWorkers Invocation Logsを集計する。refreshのCPU時間と混ぜない。
- Rate LimitingまたはWAFの誤検知は、該当イベント、path、method、action、時間帯を確認し、正規refreshの契約を維持したままルールを調整する。

## rollback

復元操作の具体的な手順は [お知らせアーカイブ条件付き復元runbook](./news-archive-restore-runbook.md) を参照する。

- HTTP API、SSG shell、Worker export、refresh制御にregressionがある場合は、反映直前に記録した正常なWorker versionへ戻す。DO stateを使用する版から旧R2制御版へ戻す場合は、切り替え前のR2 stateとDO側のleaseまたはcooldownの不一致を確認する。
- `archive/current.json`だけが不正な場合は、restore runbookに従ってaccount、snapshot digest、current ETagを確認してから復元する。
- 条件不一致や復元競合では無条件上書きを行わず、最新のdry-runからやり直す。
- R2から復元できない場合だけ、APIの読み込み先をlegacyデータへ戻すコード変更を検討する。
- backup snapshot、legacy object、R2の`control/news-refresh.json`を削除しない。Durable Object stateのリセットは、実行中refreshがないことを確認し、専用の運用手順を用意してから行う。
- Rate LimitingまたはWAFの誤設定で正規refreshが失敗する場合は、アプリケーションのlease、cooldown、200/202/429/503契約を変更せず、該当するエッジルールだけを見直す。
