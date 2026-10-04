# パフォーマンスログ集計

## 取得条件

- Worker: `kf3notif`
- データセット: `cloudflare-workers`
- 取得方法: Cloudflare CLI `cf observability telemetry query`
- 対象期間: 2026-09-27T04:38:23.347Z から 2026-10-04T04:38:18.000Z
- 対象期間長: 7日
- Wranglerのログ設定: `head_sampling_rate = 1`
- Invocation件数: 114
- Invocation CPU時間合計: 2,331 ms

## 集計値の意味

- CPU時間はInvocation Logの`$workers.cpuTimeMs`を集計した値です。
- Wall時間はInvocation Logの`$workers.wallTimeMs`を集計した値です。
- フェーズ時間はアプリケーションログの各`*DurationMs`を集計した経過時間です。現在のログからフェーズ単位のCPU時間は算出できません。
- 入れ子または並列実行されるフェーズがあるため、フェーズ時間の合計は全体時間と一致しない場合があります。
- パス別表はfetch Invocationのみです。Durable Objectの`jsrpc`、Queue、Scheduledはイベント種別別表に分けています。

## パス別Invocation

| 対象                                    | 件数 | CPU合計(ms) | CPU平均(ms) | CPU p50(ms) | CPU p95(ms) | CPU p99(ms) | CPU最大(ms) | Wall平均(ms) | Wall p50(ms) | Wall p95(ms) | Wall p99(ms) | Wall最大(ms) |
| --------------------------------------- | ---: | ----------: | ----------: | ----------: | ----------: | ----------: | ----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| `POST /api/kf3-news/refresh`            |   23 |         945 |       41.09 |          30 |          74 |         122 |         122 |     3,524.74 |        3,921 |        6,316 |        6,805 |        6,805 |
| `GET /api/kf3-news`                     |   34 |         557 |       16.38 |          15 |          30 |          32 |          32 |       670.59 |          394 |        2,757 |        3,040 |        3,040 |
| `GET /robots.txt`                       |   12 |          35 |        2.92 |           2 |           7 |           7 |           7 |         3.50 |            3 |            9 |            9 |            9 |
| `GET /apple-touch-icon-precomposed.png` |    1 |           1 |           1 |           1 |           1 |           1 |           1 |            1 |            1 |            1 |            1 |            1 |
| `GET /apple-touch-icon-160x160.png`     |    1 |           1 |           1 |           1 |           1 |           1 |           1 |            1 |            1 |            1 |            1 |            1 |

## イベント種別別Invocation

| 対象        | 件数 | CPU合計(ms) | CPU平均(ms) | CPU p50(ms) | CPU p95(ms) | CPU p99(ms) | CPU最大(ms) | Wall平均(ms) | Wall p50(ms) | Wall p95(ms) | Wall p99(ms) | Wall最大(ms) |
| ----------- | ---: | ----------: | ----------: | ----------: | ----------: | ----------: | ----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| `fetch`     |   71 |       1,539 |       21.68 |          16 |          71 |         122 |         122 |     1,463.56 |          422 |        5,332 |        6,805 |        6,805 |
| `queue`     |    8 |         532 |       66.50 |          63 |          87 |          87 |          87 |     5,706.50 |        5,739 |        6,387 |        6,387 |        6,387 |
| `scheduled` |    7 |         210 |          30 |           8 |          70 |          70 |          70 |     8,778.14 |        6,600 |       15,352 |       15,352 |       15,352 |
| `jsrpc`     |   28 |          50 |        1.79 |           2 |           3 |           4 |           4 |       188.46 |           74 |          701 |          769 |          769 |

## `GET /api/kf3-news`のフェーズ時間

| データソース | フェーズ                    | 件数 | 合計(ms) | 平均(ms) | p50(ms) | p95(ms) | p99(ms) | 最大(ms) |
| ------------ | --------------------------- | ---: | -------: | -------: | ------: | ------: | ------: | -------: |
| `merged-kv`  | `primary cache read`        |   30 |   11,149 |   371.63 |     357 |     877 |     997 |      997 |
| `merged-kv`  | `refresh state read`        |   30 |    6,006 |   200.20 |     248 |     274 |     306 |      306 |
| `merged-kv`  | `snapshot cache read`       |   30 |        0 |        0 |       0 |       0 |       0 |        0 |
| `merged-kv`  | `archive read`              |   30 |        0 |        0 |       0 |       0 |       0 |        0 |
| `merged-kv`  | `official check state read` |   30 |        0 |        0 |       0 |       0 |       0 |        0 |
| `merged-kv`  | `total`                     |   30 |   11,149 |   371.63 |     357 |     877 |     997 |      997 |
| `r2`         | `primary cache read`        |    4 |    1,134 |   283.50 |     258 |     485 |     485 |      485 |
| `r2`         | `refresh state read`        |    4 |      879 |   219.75 |     253 |     263 |     263 |      263 |
| `r2`         | `snapshot cache read`       |    4 |      862 |   215.50 |     253 |     265 |     265 |      265 |
| `r2`         | `archive read`              |    4 |    2,776 |      694 |     825 |     925 |     925 |      925 |
| `r2`         | `official check state read` |    4 |    1,917 |   479.25 |     519 |     675 |     675 |      675 |
| `r2`         | `total`                     |    4 |    4,789 | 1,197.25 |   1,038 |   1,436 |   1,436 |    1,436 |

## `POST /api/kf3-news/refresh`のフェーズ時間

| データソース | フェーズ                | 件数 | 合計(ms) | 平均(ms) | p50(ms) | p95(ms) | p99(ms) | 最大(ms) |
| ------------ | ----------------------- | ---: | -------: | -------: | ------: | ------: | ------: | -------: |
| `current`    | `refresh lease acquire` |    7 |    3,680 |   525.71 |     393 |   1,088 |   1,088 |    1,088 |
| `current`    | `refresh eligibility`   |    7 |    2,508 |   358.29 |     378 |     578 |     578 |      578 |
| `current`    | `refresh fetch`         |    7 |    7,873 | 1,124.71 |   1,184 |   1,649 |   1,649 |    1,649 |
| `current`    | `official fetch`        |    7 |    1,312 |   187.43 |     138 |     336 |     336 |      336 |
| `current`    | `refresh cache read`    |    7 |       38 |     5.43 |       5 |      12 |      12 |       12 |
| `current`    | `archive read`          |    7 |    4,015 |   573.57 |     491 |   1,065 |   1,065 |    1,065 |
| `current`    | `archive body read`     |    7 |      193 |    27.57 |      18 |      65 |      65 |       65 |
| `current`    | `archive json parse`    |    7 |        0 |        0 |       0 |       0 |       0 |        0 |
| `current`    | `archive validation`    |    7 |        0 |        0 |       0 |       0 |       0 |        0 |
| `current`    | `client projection`     |    7 |        0 |        0 |       0 |       0 |       0 |        0 |
| `current`    | `client json stringify` |    7 |        0 |        0 |       0 |       0 |       0 |        0 |
| `current`    | `cache put`             |    7 |    8,924 | 1,274.86 |     998 |   2,064 |   2,064 |    2,064 |
| `current`    | `refresh state put`     |    7 |    3,614 |   516.29 |     607 |     662 |     662 |      662 |
| `current`    | `current etag check`    |    7 |      802 |   114.57 |      82 |     213 |     213 |      213 |
| `current`    | `lease completion`      |    7 |      325 |    46.43 |      16 |     124 |     124 |      124 |
| `current`    | `refresh finalization`  |    7 |   13,665 | 1,952.14 |   1,739 |   2,766 |   2,766 |    2,766 |
| `current`    | `refresh total`         |    7 |   25,218 | 3,602.57 |   3,490 |   4,476 |   4,476 |    4,476 |
| `full-merge` | `refresh lease acquire` |    8 |    3,596 |   449.50 |     393 |     708 |     708 |      708 |
| `full-merge` | `refresh eligibility`   |    8 |    3,186 |   398.25 |     192 |   1,262 |   1,262 |    1,262 |
| `full-merge` | `refresh fetch`         |    8 |   11,756 | 1,469.50 |     897 |   3,297 |   3,297 |    3,297 |
| `full-merge` | `official fetch`        |    8 |    4,846 |   605.75 |     227 |   1,706 |   1,706 |    1,706 |
| `full-merge` | `refresh cache read`    |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `full-merge` | `archive read`          |    8 |    3,724 |   465.50 |     191 |   1,548 |   1,548 |    1,548 |
| `full-merge` | `archive body read`     |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `full-merge` | `archive json parse`    |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `full-merge` | `archive validation`    |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `full-merge` | `client projection`     |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `full-merge` | `client json stringify` |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `full-merge` | `cache put`             |    8 |    9,267 | 1,158.38 |   1,093 |   1,994 |   1,994 |    1,994 |
| `full-merge` | `refresh state put`     |    8 |    3,703 |   462.88 |     521 |     618 |     618 |      618 |
| `full-merge` | `current etag check`    |    8 |    1,177 |   147.13 |      84 |     263 |     263 |      263 |
| `full-merge` | `lease completion`      |    8 |      530 |    66.25 |      22 |     168 |     168 |      168 |
| `full-merge` | `refresh finalization`  |    8 |   14,677 | 1,834.63 |   1,774 |   2,709 |   2,709 |    2,709 |
| `full-merge` | `refresh total`         |    8 |   30,029 | 3,753.63 |   3,368 |   5,148 |   5,148 |    5,148 |
| `kv`         | `refresh lease acquire` |    8 |    2,292 |   286.50 |      84 |     788 |     788 |      788 |
| `kv`         | `refresh eligibility`   |    8 |      953 |   119.13 |     111 |     149 |     149 |      149 |
| `kv`         | `refresh fetch`         |    8 |    2,261 |   282.63 |     242 |     397 |     397 |      397 |
| `kv`         | `official fetch`        |    8 |    1,249 |   156.13 |     135 |     240 |     240 |      240 |
| `kv`         | `refresh cache read`    |    8 |       59 |     7.38 |       6 |      13 |      13 |       13 |
| `kv`         | `archive read`          |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `kv`         | `archive body read`     |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `kv`         | `archive json parse`    |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `kv`         | `archive validation`    |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `kv`         | `client projection`     |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `kv`         | `client json stringify` |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `kv`         | `cache put`             |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `kv`         | `refresh state put`     |    8 |    4,997 |   624.63 |     618 |     654 |     654 |      654 |
| `kv`         | `current etag check`    |    8 |        0 |        0 |       0 |       0 |       0 |        0 |
| `kv`         | `lease completion`      |    8 |      131 |    16.38 |      15 |      26 |      26 |       26 |
| `kv`         | `refresh finalization`  |    8 |    5,128 |      641 |     630 |     680 |     680 |      680 |
| `kv`         | `refresh total`         |    8 |    9,681 | 1,210.13 |     959 |   1,796 |   1,796 |    1,796 |

## アーカイブ更新の処理時間

`news_archive_update`ログの`processingMs`をトリガー別に集計しています。

| トリガー    | 件数 | processing合計(ms) | 平均(ms) | p50(ms) | p95(ms) | p99(ms) | 最大(ms) |
| ----------- | ---: | -----------------: | -------: | ------: | ------: | ------: | -------: |
| `queue`     |    8 |             45,610 | 5,701.25 |   5,734 |   6,385 |   6,385 |    6,385 |
| `scheduled` |    7 |             60,192 | 8,598.86 |   6,419 |  15,176 |  15,176 |   15,176 |

## 集計元ログ件数

| ログ種別                               | 件数 |
| -------------------------------------- | ---: |
| `news_api_succeeded`, `merged-kv`      |   30 |
| `news_api_succeeded`, `r2`             |    4 |
| `news_refresh_succeeded`, `kv`         |    8 |
| `news_refresh_succeeded`, `current`    |    7 |
| `news_refresh_succeeded`, `full-merge` |    8 |
| `news_archive_update`, `scheduled`     |    7 |
| `news_archive_update`, `queue`         |    8 |

## Cloudflareクエリ統計

| 集計                                  | 読み取り行数 | 読み取りバイト数 | API処理時間(秒) |
| ------------------------------------- | -----------: | ---------------: | --------------: |
| パス別Invocation                      |   19,900,456 |      827,044,578 |           2.156 |
| イベント種別別Invocation              |   19,890,101 |      792,334,296 |           3.003 |
| `GET /api/kf3-news`フェーズ           |   19,887,261 |      879,953,506 |           2.996 |
| `POST /api/kf3-news/refresh`フェーズ1 |   19,959,309 |      881,035,419 |           2.624 |
| `POST /api/kf3-news/refresh`フェーズ2 |   19,934,617 |      882,713,355 |           3.538 |
| `POST /api/kf3-news/refresh`フェーズ3 |   19,883,376 |      882,393,951 |           2.981 |
| アーカイブ更新                        |   19,892,383 |      881,519,902 |           2.823 |
