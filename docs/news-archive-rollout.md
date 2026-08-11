# ニュースアーカイブ導入状態

## 現在の状態

ニュースアーカイブのコードとリポジトリ設定は実装済みで、本番Cron Triggerも1本登録済みである。初回のscheduled実行、R2バックアップ、復元dry-run、Invocation Log、更新成功ログまで確認済みで、CPU基準の解消、エラー経路、次回実行の確認が残っている。

| 項目            | 状態                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本番Worker      | scheduled handler、バックアップbinding、heartbeatを含むコードを反映済み。確認済みversionは`07d44aeb-15ea-4dda-baa3-deb272c53329`                   |
| HTTP API        | HTTP 200。5599件、4フィールドのトップレベル配列を確認済み                                                                                          |
| legacy route    | HTTP 200とimmutable cacheを維持                                                                                                                    |
| Cron Trigger    | 対象Workerに`15 18 * * *`を1本登録済み。初回実行のscheduledTimeは`2026-08-08T18:15:10Z`。Invocation Logは`outcome: ok`、CPU 44ms。次回実行は未確認 |
| 累積アーカイブ  | `archive/current.json`を作成済み。5599件、1,472,401 bytes、期間は2019年9月24日から2026年8月9日、ETagは`62e22334c9c5167753f076a4dc0b1405`           |
| バックアップ    | `daily/2026/08/09/2026-08-08T18-15-10Z.json`と`monthly/2026-08.json`を作成済み。dailyは4013件、monthlyはcurrentと同一内容                          |
| Healthchecks.io | `kf3notif-daily-archive`をUTC `15 18 * * *`、grace 30分で作成済み。checkはUpで、メール通知の受信を確認済み                                         |
| Worker secret   | `HEALTHCHECKS_PING_URL`を設定済み。URL自体はログとGitへ保存しない                                                                                  |
| 復元ツール      | localhost専用Workerでdailyとmonthlyの本番snapshotをdry-run済み。両方とも`writes`は`{"r2Puts":0,"kvDeletes":0}`                                     |

初回scheduled実行の更新前dailyは4013件、1,496,728 bytes、期間は2019年9月24日から2024年11月6日だった。dailyの復元dry-run digestは`5877b8018daffdfc244a541ee8d948626195d1a2c811c92e90724e52e215bf39`で、currentへのlegacy ID欠落は0件だった。currentとmonthlyはどちらも5599件、1,472,401 bytesで、同じETagを持つ。

初回CronのInvocation Logは、`2026-08-08T18:15:10.428Z`、request ID `9JUH85IACFP16S2Z`、Worker version `07d44aeb-15ea-4dda-baa3-deb272c53329`、`outcome: ok`、`wallTimeMs: 5786`、`cpuTimeMs: 44`だった。Cron自体は成功したが、CPU 44msは10ms基準を超過している。

同じrequest IDの`news_archive_update`成功ログでは、`sourceKey`が`entries_merged_20241107.json`、`beforeCount`が4013件、`officialCount`が2000件、`addedCount`が1586件、`updatedCount`が6件、`mergedCount`が5599件、`officialResponseBytes`が631,366 bytes、`processingMs`が4,585msだった。dailyとmonthlyは作成済みで、`updatedEtag`は`62e22334c9c5167753f076a4dc0b1405`だった。`processingMs`はI/O待ちを含む経過時間であり、CPU時間とは別に扱う。

## 保留理由

初回実行のCPU 44msが10ms基準を超過しており、構造化errorログ、heartbeat、次回scheduled実行時の変更なし経路の確認も残っている。

### Cron Triggerの運用方針

Workers Freeを継続し、Cron Triggerは`15 18 * * *`の1本だけ登録した。追加のCron Triggerは作成せず、空き枠を残す。対象Workerのschedule登録はWranglerのデプロイ結果で確認済みである。

### CPU時間

Workers FreeのCron Triggerは1回あたりCPU 10msが上限である。このブランチでは、scheduled通常経路の再帰的JSON正規化、SHA-256、既存月次バックアップの全件再検証を行わず、保存済みアーカイブの日付再解析と統合後の不変条件再走査も省略している。一時的な超過許容には依存しない。

Invocation Logで初回CronのCPU 44msを確認した。10ms基準を満たすまで、本番相当データでCPU profileを取り、処理を削減して再計測する。

公式配信元のETagと`If-None-Match`を使う実装を反映済みである。scheduled処理とページリクエストのKV cache missでは、R2 stateの公式ETagとcurrent ETagの対応を確認できた場合に条件付きGETを行う。KV cache hitは従来どおり外部I/Oを行わない。本番での304応答、CPU時間、304率、API cache missのレイテンシは未確認であり、受け入れ条件として継続確認する。設計と確認項目は [ニュースアーカイブETag条件付き取得案](./news-archive-etag-optimization.md) に記載する。

## 残りの確認手順

1. Workers Logsで初回実行のheartbeatと構造化errorログの有無を確認する。
2. CPU 44msの原因を本番相当データでprofileし、10ms以内に収めて再計測する。
3. 次回の03:15 JST実行後に、scheduledの304経路でcurrent、KV、daily、monthlyが不要に更新されないことと、monthly欠落補完を確認する。
4. APIのKV cache missで条件付きGETと304時のcurrent投影を確認し、cache hitでR2と公式サーバーへアクセスしないことを確認する。
5. 次回実行までに異常がなければ、本番Cronの導入完了判定を行う。

## 受け入れ条件

- [ ] 手動操作なしで毎日03:15 JSTに実行される。
- [x] Healthchecks.ioから失敗またはCron欠落のメール通知を実受信できる。
- [x] 2019年9月24日以降の既存IDがすべて`archive/current.json`に維持される。
- [ ] 公式サイトから消えたIDが残り、同一IDの更新には公式内容が採用される。
- [ ] 不正取得、閾値超過、日次バックアップ失敗でcurrentとKVが変更されない。
- [x] 更新前dailyと本番反映済みmonthlyを再検証できる。
- [ ] ETag競合時にcurrent、KV、monthlyが誤って確定しない。
- [ ] scheduledとAPI cache missで条件付きGETと304経路が確認できる。
- [ ] API cache hitでR2と公式サーバーへの外部I/Oが発生しない。
- [x] 本番snapshotを使った復元dry-runでR2とKVへのwriteが0件になる。
- [ ] successとerrorの構造化ログをWorkers Logsで確認できる（success確認済み、error未確認）。
- [ ] 本番相当データでscheduled処理のCPU時間が10ms以内に収まる。
- [ ] 初回と次回のCron実行を確認できる。

すべてを確認するまで、本番Cronの導入は完了扱いにしない。

## ロールバック

- HTTP API、legacy route、Worker exportにregressionがある場合は、反映直前に記録した正常なWorker versionへ戻す。
- `archive/current.json`だけが不正な場合は、復元ツールをdry-runし、account、snapshot digest、current ETagを確認してから明示的にapplyする。
- 復元applyは正常snapshotを最新ETag条件でcurrentへ戻し、成功後だけKVを削除する。条件不一致の場合は無条件上書きせず、最新のdry-runからやり直す。
- R2から復元できない場合だけ、APIの読み込み先をlegacyデータへ戻すコード変更を行う。
- backup snapshotとlegacy objectは削除しない。
