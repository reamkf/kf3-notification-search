# ニュースアーカイブ導入状態

## 現在の状態

ニュースアーカイブのコードとリポジトリ設定は実装済みで、本番Cron Triggerも1本登録済みである。次回のscheduled実行後に、初回移行、CPU時間、バックアップ、ログの受け入れ確認を行う。

| 項目            | 状態                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 本番Worker      | scheduled handler、バックアップbinding、heartbeatを含むコードを反映済み。確認済みversionは`07d44aeb-15ea-4dda-baa3-deb272c53329` |
| HTTP API        | cache missとcache hitがHTTP 200。5598件、4フィールドのトップレベル配列を確認済み                                                 |
| legacy route    | HTTP 200とimmutable cacheを維持                                                                                                  |
| Cron Trigger    | 対象Workerに`15 18 * * *`を1本登録済み。初回のscheduled実行とCPU時間は未確認                                                     |
| 累積アーカイブ  | 本番の`archive/current.json`は未作成。APIはlegacyデータと公式データを統合して応答している                                        |
| バックアップ    | `daily/`の90日Lifecycle、`daily/`と`monthly/`の30日Bucket Lockを設定済み。本番snapshotは未作成                                   |
| Healthchecks.io | `kf3notif-daily-archive`をUTC `15 18 * * *`、grace 30分で作成済み。checkはUpで、メール通知の受信を確認済み                       |
| Worker secret   | `HEALTHCHECKS_PING_URL`を設定済み。URL自体はログとGitへ保存しない                                                                |
| 復元ツール      | localhost専用Worker、default dry-run、ETag条件付きapplyを実装済み。本番snapshotを使ったdry-runは未実施                           |

本番反映前の確認では、legacyデータは4013件、1,496,728 bytes、期間は2019年9月24日から2024年11月6日、SHA-256は`5877b8018daffdfc244a541ee8d948626195d1a2c811c92e90724e52e215bf39`だった。公式データは2000件、631,207 bytes、期間は2024年6月2日から2026年8月2日、既存ID更新は6件だった。ローカル統合結果は5579件で、legacy IDの欠落は0件だった。再開時はこれらを固定値として使わず、リモートデータをread-onlyで再取得して差分を確認する。

## 保留理由

本番Cron登録後のCPU時間の確認と初回実行後の運用確認が残っている。

### Cron Triggerの運用方針

Workers Freeを継続し、Cron Triggerは`15 18 * * *`の1本だけ登録した。追加のCron Triggerは作成せず、空き枠を残す。対象Workerのschedule登録はWranglerのデプロイ結果で確認済みである。

### CPU時間

Workers FreeのCron Triggerは1回あたりCPU 10msが上限である。このブランチでは、scheduled通常経路の再帰的JSON正規化、SHA-256、既存月次バックアップの全件再検証を行わず、保存済みアーカイブの日付再解析と統合後の不変条件再走査も省略している。初回実行後に、本番相当データを使ったCPU profileとWorkers Invocation Logsで10ms以内に収まることを確認する。一時的な超過許容には依存しない。

初回のscheduled実行後に、本番相当データでscheduled処理のCPU時間を計測し、Workers Freeの上限内であることを確認する。

## 再開手順

1. Workers Freeを継続し、Cron Triggerを1本だけ登録する方針を確認する。
2. `bun run test`、`bun run lint`、`bun run format:check`、`bunx tsc --noEmit`、`bun run build`、`bunx wrangler deploy --dry-run`を実行する。
3. ローカルscheduled処理を初回と再実行の2回確認し、ID包含、daily/current/monthlyの内容、変更なし時の非更新を確認する。
4. 対象Cloudflareアカウント、Worker、data bucket、backup bucket、現在のWorker versionを表示して確認する。
5. `archive/current.json`、legacyデータ、公式データ、バックアップrule、Healthchecks.io、Worker secretの状態をread-onlyで再確認する。
6. メンテナーが対応できる日の10:00から15:00 JSTに反映し、直前の正常なWorker versionをrollback対象として記録する。
7. HTTP APIとlegacy routeの互換性を確認し、対象WorkerにCron `15 18 * * *`が登録されたことを確認する。
8. 次の03:15 JST実行後に、heartbeat、Workers Logs、daily snapshot、`archive/current.json`、monthly snapshot、KV、APIを相互照合する。
9. 本番snapshotを復元ツールでdry-runし、`writes`が`{"r2Puts":0,"kvDeletes":0}`であることを確認する。実障害がなければapplyしない。
10. 次回の03:15 JST実行後に、変更なし時の非更新または変更時だけの条件付き更新を確認する。

## 受け入れ条件

- [ ] 手動操作なしで毎日03:15 JSTに実行される。
- [x] Healthchecks.ioから失敗またはCron欠落のメール通知を実受信できる。
- [ ] 2019年9月24日以降の既存IDがすべて`archive/current.json`に維持される。
- [ ] 公式サイトから消えたIDが残り、同一IDの更新には公式内容が採用される。
- [ ] 不正取得、閾値超過、日次バックアップ失敗でcurrentとKVが変更されない。
- [ ] 更新前dailyと本番反映済みmonthlyを再検証できる。
- [ ] ETag競合時にcurrent、KV、monthlyが誤って確定しない。
- [ ] 本番snapshotを使った復元dry-runでR2とKVへのwriteが0件になる。
- [ ] successとerrorの構造化ログをWorkers Logsで確認できる。
- [ ] 本番相当データでscheduled処理のCPU時間が10ms以内に収まる。
- [ ] 初回と次回のCron実行を確認できる。

すべてを確認するまで、本番Cronの導入は完了扱いにしない。

## ロールバック

- HTTP API、legacy route、Worker exportにregressionがある場合は、反映直前に記録した正常なWorker versionへ戻す。
- `archive/current.json`だけが不正な場合は、復元ツールをdry-runし、account、snapshot digest、current ETagを確認してから明示的にapplyする。
- 復元applyは正常snapshotを最新ETag条件でcurrentへ戻し、成功後だけKVを削除する。条件不一致の場合は無条件上書きせず、最新のdry-runからやり直す。
- R2から復元できない場合だけ、APIの読み込み先をlegacyデータへ戻すコード変更を行う。
- backup snapshotとlegacy objectは削除しない。
