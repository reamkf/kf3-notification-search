# 公式ニュース配信仕様

## 配信元

- Origin: `https://kemono-friends-3.jp`
- Endpoint: `https://kemono-friends-3.jp/info/all/entries.txt`
- HTTP method: `GET`
- `Content-Type`: `text/plain`

## 公式ニュースデータ

HTTP 200の本文形式は、次のJSONオブジェクト。

```json
{
  "news": [
    {
      "id": 1234567890,
      "targetUrl": "/info/detail/011831iRwmQ483.html",
      "title": "お知らせのタイトル",
      "newsDate": "2026年08月02日 12時00分00秒",
      "updated": "2026.08.11",
      "category": "【サイト】アプリ,おしらせ"
    }
  ]
}
```

各フィールドの形式は次のとおり。

| フィールド  | 形式                                                                  |
| ----------- | --------------------------------------------------------------------- |
| `id`        | JSON numberの整数、正の値                                             |
| `targetUrl` | JSON string、`/info/detail/`に続く英数字と`.html`で構成される相対パス |
| `title`     | JSON string                                                           |
| `newsDate`  | `yyyy年MM月dd日 HH時mm分ss秒`形式のJSON string                        |
| `updated`   | `YYYY.MM.DD`形式のJSON string、例は`2026.08.11`                       |
| `category`  | JSON string、複数の分類名は半角カンマ区切り                           |

### `targetUrl`

`targetUrl`の配信値は、次の形式。

```text
/info/detail/<英数字>.html
```

配信値の例は次のとおり。

```text
/info/detail/011831iRwmQ483.html
```

### `updated`

`updated`の配信値は、ピリオド区切りの西暦年月日。

```text
YYYY.MM.DD
```

配信値の例は`2026.08.11`、`2024.11.14`。

### `category`

`category`の配信値は、複数の分類名を半角カンマで連結した文字列。配信値の例は次のとおり。

```text
【サイト】アプリ,おしらせ
【サイト】アプリ,重要
```

## 取得データで確認できる事実

取得したHTTP 200のレスポンスで確認した内容。

- `news`: 2,000件
- `id`: 2,000件、重複なし
- `targetUrl`: 2,000件すべて`/info/detail/<英数字>.html`形式
- `updated`: 2,000件すべて`YYYY.MM.DD`形式
- `category`: 2,000件すべてに存在し、半角カンマを含む

## JSON掲載件数と個別HTML

- 公式JSONに含まれるお知らせは最新2,000件まで。
- 2,000件を超えた場合、古いお知らせからJSONに含まれなくなる。
- JSONから除外されたお知らせも、`targetUrl`のHTMLリンクが分かっていれば個別ページへアクセスできる。

## HTTP応答

### 通常のGET

条件なしの`GET`はHTTP 200と本文を返す。本文はUTF-8でデコード可能なJSON。

### 条件付きGET

前回のHTTP応答で返したETagを`If-None-Match`へ指定した`GET`には、次のいずれかを返す。

- HTTP 200: データが変更された場合。本文を含む。
- HTTP 304: データが変更されていない場合。本文を含まない。

HTTP 304のレスポンスにETagが含まれる場合は、リクエストに指定したETagと一致する。

## ETag

公式サーバーが返すETagは、RFC準拠の単一strong entity-tag。

### 値の形式

ETagのHTTPヘッダー値全体は、引用符で囲んだopaque-tag。形式は次のとおり。

```text
"<opaque-tag>"
```

`opaque-tag`には、HTTP entity-tagで許可される文字を使用する。空のopaque-tagも配信できる。配信値の例は次のとおり。

```text
"02ab15c528a97b884e99dac640ff02ba"
""
```

弱いETagの形式`W/"<opaque-tag>"`や、複数のentity-tagを含む形式はstrong ETagではない。

条件付きGETでは、前回のstrong ETagを`If-None-Match`へ指定する。
