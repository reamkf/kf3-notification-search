# お知らせアーカイブ導入状態

## 導入対象

本番Workerは次の処理を提供する。

- `GET /`はお知らせ取得を行わないSSR shellを返す。
- `GET /api/kf3-news`はKV snapshotを即時返却し、KV miss時はR2のcurrentまたはlegacy snapshotを投影する。
- `POST /api/kf3-news/refresh`は公式データを取得、検証、mergeし、成功結果を表示用KVへ保存して`{news, metadata}`形式で200を返す。実行中は202、cooldownは429、依存障害は503を返す。
- refreshはR2 CAS leaseと5分cooldownで制限し、Cloudflare Rate LimitingとWAFで公開routeを保護する。
- refreshは表示用KVとrefresh制御metadataだけを変更し、current、daily、monthly、公式ETag stateを変更しない。
- scheduledの`updateNewsArchive`だけが公式データを永続archiveへ反映し、daily、monthly、公式ETag stateを更新する。
- restoreはlocalhost専用Workerとしてsnapshotからcurrentを条件付きで復元する。

共通契約は [お知らせ機能共通仕様](./news-spec.md)、APIは [お知らせページリクエスト仕様](./news-page-request-spec.md)、scheduledは [お知らせアーカイブ定期実行更新仕様](./news-archive-scheduled-spec.md)、ETagは [お知らせアーカイブETag条件付き取得の実装仕様](./news-archive-etag-optimization.md) を参照する。

## 外部状態の確認項目

本番反映後は、現行Worker version、Cron、R2、KV、refresh制御metadata、Healthchecks.io、Cloudflare Rate Limiting、WAFの設定を同じ運用記録で確認する。secret、lease token、ETag、公式本文は記録しない。

| 項目                     | 確認内容                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 本番Worker               | 現HEADに対応するWorker versionへ反映され、`GET /`、GET、refresh、scheduledが有効                                                                |
| HTTP `/`                 | SSR shellだけを返し、レスポンス中にお知らせ配列を含まず、shell処理中にお知らせ取得を開始しない                                                  |
| HTTP GET                 | KV hitがR2と公式サーバーへアクセスせず、KV missがR2 currentまたはlegacyを投影して直接返し、KVへ書き戻さない                                     |
| HTTP refresh             | 実行中は202、成功時は200と`{news, metadata}`を返し、KVへ同じ表示用データを保存する                                                              |
| refresh制御              | 別refreshの実行中は202、5分cooldown中は429、依存障害は503を返し、無条件上書きを行わない                                                         |
| refresh書き込み境界      | refresh後もcurrent、daily、monthly、公式ETag stateが変わらない                                                                                  |
| Cron Trigger             | `15 18 * * *`を1本だけ登録し、毎日03:15 JSTに実行される                                                                                         |
| scheduled archive        | 公式取得、検証、merge、CAS更新、daily/monthly backup、公式ETag state保存の順序が保たれる                                                        |
| ETag                     | scheduledの200と304、stateとcurrent ETag不一致時の完全処理を確認する                                                                            |
| Healthchecks.io          | `kf3notif-daily-archive`をUTC `15 18 * * *`、grace 30分で運用し、失敗とCron欠落を通知する                                                       |
| Cloudflare Rate Limiting | refresh routeを対象に、通常利用を許容しつつ短時間の反復POSTを抑制する。429応答と適用範囲を確認する                                              |
| Cloudflare WAF           | refresh routeにManaged Rulesと必要なカスタムルールを適用し、異常な自動化、明らかな攻撃、想定外のmethodを遮断する。正規refreshの誤検知を確認する |
| restore                  | localhost専用Workerをdeployせず、dry-runがR2とKVへ書き込まない                                                                                  |

## refresh運用ポリシー

refreshは公開APIであり、アプリケーション内のR2 CAS leaseと5分cooldownを必須の制御として扱う。Cloudflareのエッジ制御はアプリケーション制御の代替ではない。

### Cloudflare Rate Limitingの推奨

- 対象は`POST /api/kf3-news/refresh`に限定する。
- 送信元IPを基準に、短時間の反復POSTを抑制する。通常のUI操作と、複数クライアントからの同時refreshを分けて観測できる閾値から開始する。
- originの429契約を尊重し、Rate Limitingによる拒否も429としてクライアントへ伝わることを確認する。
- GET `/api/kf3-news`や`GET /`をrefresh用の厳しい制限へ巻き込まない。
- Workers LogsとRate Limiting eventで、許可数、429数、送信元分布、誤検知を確認し、利用状況に応じて閾値を調整する。

### WAFの推奨

- Managed Rulesを有効化し、Workers APIを対象とした明らかな攻撃パターンを遮断する。
- refresh routeへ、POST以外を拒否するcustom rule、想定外に大きいrequest bodyを拒否するcustom rule、明らかな自動化や異常な送信元をchallengeまたはblockするcustom ruleを検討する。
- API本文を検査するルールでは、正規JSONのrefreshを誤検知しないことを確認する。WAFがbodyを許可しても、アプリケーションのJSON検証、公式データ検証、R2 CAS leaseを省略しない。
- WAFのblock、challenge、skipの変更は、refreshの200、202、429、503契約とWorkers Logsのイベントを突き合わせて確認する。

## 受け入れ条件

- [ ] `GET /`がお知らせ取得なしのSSR shellを返す。
- [ ] GETのKV hitがKVだけで完了する。
- [ ] GETのKV missがR2 currentまたはlegacyだけを投影して直接返し、KVへの書き込み、公式取得、mergeを行わない。
- [ ] refresh実行中が202と`Retry-After`を返し、成功時は200と`{news, metadata}`を返して表示用KVへ保存する。
- [ ] refreshのcooldownが429と`Retry-After`を返す。
- [ ] refreshのR2、公式、検証、merge、KV保存の依存障害が503を返す。
- [ ] refreshがcurrent、daily、monthly、公式ETag stateを変更しない。
- [ ] refresh成功とscheduled更新が別HTTPリクエストとしてCPU時間へ記録される。
- [ ] `waitUntil`なしでshell、GET、refresh、scheduledの処理完了を確認できる。
- [ ] 手動操作なしで毎日03:15 JSTにscheduledが実行される。
- [ ] Healthchecks.ioからCron失敗またはCron欠落の通知を実受信できる。
- [ ] 公式サイトから消えたIDがscheduled archiveに残り、同一IDの更新には公式内容が採用される。
- [ ] 不正取得、閾値超過、日次backup失敗でcurrentとKVが変更されない。
- [ ] ETag競合時にcurrent、KV、monthlyが誤って確定しない。
- [ ] scheduledの200と304、stateとcurrent ETag不一致時の完全処理を確認できる。
- [ ] Cloudflare Rate Limitingがrefreshの反復POSTを抑制し、正規の利用を不必要に拒否しない。
- [ ] Cloudflare WAFが異常なrefresh requestを遮断し、正規JSONを誤検知しない。
- [ ] 本番snapshotを使ったrestore dry-runでR2とKVへのwriteが0件になる。
- [ ] `news_refresh_succeeded`、`news_refresh_failed`を含む構造化ログをWorkers Logsで確認できる。
- [ ] scheduled、GET、refreshのCPU時間を別リクエストとして確認できる。

## 障害調査

- shellやGETが遅い場合は、`GET /`と`GET /api/kf3-news`の外部I/O、KV hit率、R2 snapshot読み込みを確認する。GETが公式サーバーへアクセスしていないことを確認する。
- refreshが202の場合は実行中leaseと`Retry-After`を確認する。429の場合は5分cooldown、`Retry-After`、Cloudflare Rate Limiting eventを確認する。
- refreshが503の場合は、`news_refresh_failed`の`stage`、R2 lease、公式取得、検証、merge、KV保存のどこで失敗したかを確認する。成功時は`news_refresh_succeeded`を確認する。失敗前のKV、current、公式ETag stateが変更されていないことを確認する。
- scheduledが失敗した場合は、`news_archive_update_failed`の`stage`、`error`、`details`を確認する。公式本文、ETag、secretはログへ出力しない。
- 304率やCPU時間を確認するときは、scheduledの`officialFetchStatus`別にWorkers Invocation Logsを集計する。refreshのCPU時間と混ぜない。
- Rate LimitingまたはWAFの誤検知は、該当イベント、path、method、action、時間帯を確認し、正規refreshの契約を維持したままルールを調整する。

## rollback

復元操作の具体的な手順は [お知らせアーカイブ条件付き復元runbook](./news-archive-restore-runbook.md) を参照する。

- HTTP API、SSR shell、Worker export、refresh制御にregressionがある場合は、反映直前に記録した正常なWorker versionへ戻す。
- `archive/current.json`だけが不正な場合は、restore runbookに従ってaccount、snapshot digest、current ETagを確認してから復元する。
- 条件不一致や復元競合では無条件上書きを行わず、最新のdry-runからやり直す。
- R2から復元できない場合だけ、APIの読み込み先をlegacyデータへ戻すコード変更を検討する。
- backup snapshot、legacy object、refresh制御metadataを削除しない。
- Rate LimitingまたはWAFの誤設定で正規refreshが失敗する場合は、アプリケーションのlease、cooldown、200/202/429/503契約を変更せず、該当するエッジルールだけを見直す。
