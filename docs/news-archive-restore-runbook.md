# お知らせアーカイブ条件付き復元runbook

## 目的と適用範囲

本runbookは、`archive/current.json`が破損した場合に、dailyまたはmonthlyのsnapshotから条件付きで復元する手順を定義する。

復元APIのrequest形式、snapshot keyの制約、dry-run/applyのエラーコードは [お知らせ機能共通仕様の復元仕様](./news-spec.md#復元仕様) を参照する。本書はAPI契約の全表を再掲せず、運用担当者が行う確認と操作だけを記載する。

- `wrangler.restore.toml`のlocalhost専用Workerを使用する。
- 復元Workerはdeployしない。
- 公開routeを追加しない。
- remote bindingは本番R2とKVを直接操作するため、対象を確認してから起動する。
- applyは実障害で復元が必要な場合だけ実行する。
- restoreはrefresh制御metadataを変更しない。

## 事前確認

1. 復元対象のaccountを確認する。

   ```bash
   bunx wrangler whoami
   ```

2. 対象account、R2 bucket、snapshot key、復元理由をメンテナー本人が確認する。
3. snapshot keyが次のいずれかであることを確認する。
   - `daily/YYYY/MM/DD/<snapshot>.json`
   - `monthly/YYYY-MM.json`
4. snapshotの保存日時と復元したい状態が一致することを確認する。
5. accountやsnapshot keyが不明な場合は操作を中止する。
6. `HEALTHCHECKS_PING_URL`などのsecretをコマンド、ログ、運用記録へ書き込まない。
7. refreshが実行中でないこと、Cloudflare Rate LimitingまたはWAFの運用変更を同時に行っていないことを確認する。

## localhost専用Workerの起動

リポジトリルートで次を実行する。

```bash
bun run restore:dev
```

`http://127.0.0.1:8790`でlocalhost専用Workerが起動したことを確認する。Workerをdeployしたり、公開URLから復元APIを利用したりしない。

## dry-run

`mode`を省略したrequestもdry-runとして扱われる。snapshot keyだけを指定して実行する。

```bash
curl -X POST "http://127.0.0.1:8790/restore" \
  -H "content-type: application/json" \
  --data '{"snapshotKey":"daily/YYYY/MM/DD/<snapshot>.json"}'
```

responseで次を確認する。

- snapshot digest
- 件数
- 最古日
- 最新日
- 現在の`archive/current.json`のETag
- applyで予定されるcurrent置換とKV削除
- `writes.r2Puts`が`0`
- `writes.kvDeletes`が`0`

`digest`、件数、日付範囲、現在のETag、復元目的のいずれかが想定と違う場合はapplyへ進まない。

## apply

applyには、直前のdry-runで確認したsnapshot digestとcurrent ETagをそのまま再入力する。

```bash
curl -X POST "http://127.0.0.1:8790/restore" \
  -H "content-type: application/json" \
  --data '{"mode":"apply","snapshotKey":"daily/YYYY/MM/DD/<snapshot>.json","snapshotDigest":"<dry-run digest>","currentEtag":"<dry-run etag>"}'
```

applyでは次の順序で処理される。

1. snapshotの保存用schema、全日付、ID一意性、正規化JSON、SHA-256 digestを再検証する。
2. 入力されたsnapshot digestとcurrent ETagが現在値と一致することを確認する。
3. `onlyIf.etagMatches`付きで`archive/current.json`を更新する。
4. current更新に成功した後だけKVの`kf3-news`を削除する。

条件不一致、digest不一致、current更新競合、`put()`の`null`では無条件上書きへ切り替えない。最新状態でdry-runからやり直す。

`cache_delete_failed`の場合はcurrentがすでに更新済みである可能性がある。古いETagでapplyを繰り返さず、responseに含まれる更新後ETagを記録して対応を中断する。

## 復元後の確認

1. responseの更新後current ETagを記録する。
2. KV `kf3-news`の削除結果を記録する。
3. `GET /api/kf3-news`がトップレベル配列を返すことを確認する。
4. APIの件数、最古日、最新日をdry-run結果と比較する。
5. snapshot digest、更新後ETag、KV削除結果、API確認結果が運用記録と一致することを確認する。
6. current ETagが復元前から変わったことを確認する。次回のQueue consumerまたはscheduled fallbackはETag条件付き取得ではなく、公式データの完全取得とcurrentの再統合へ戻る。
7. refresh制御metadataが変更されていないことを確認する。refreshの次回実行は通常のleaseと5分cooldownの契約に従う。
8. Cloudflare Rate LimitingとWAFのイベントに、復元作業による意図しない公開refreshやroute変更がないことを確認する。

## 復元できない場合のrollback

R2からsnapshotを読み込めない場合だけ、legacy objectを使う緊急のcode rollbackを検討する。

- 対象account、対象Worker version、legacy objectを再確認する。
- legacy objectを削除しない。
- backup snapshotを削除しない。
- R2復旧後は、通常の復元手順を最新snapshotとcurrent ETagでやり直す。
- refreshのlease、cooldown、表示用KVの契約を復元障害の回避目的で変更しない。

## 運用記録

復元を実施した場合は、次を記録する。

- 実施理由
- 対象accountとbucket
- snapshot key
- dry-run digest
- dry-run時のcurrent ETag
- apply後のcurrent ETag
- KV削除結果
- API確認結果
- refresh制御metadataに変更がないことの確認
- Rate LimitingとWAFのイベント確認結果（refreshの200、202、429、503契約への影響）
- 復元後のQueue consumerまたはscheduled fallbackの処理確認結果
