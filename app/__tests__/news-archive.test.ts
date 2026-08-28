import { describe, expect, it, vi } from "vitest";
import type {
  KVNamespace,
  R2Bucket,
  R2Conditional,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from "@cloudflare/workers-types/experimental";
import {
  CURRENT_ARCHIVE_KEY,
  LEGACY_ARCHIVE_KEY,
  OFFICIAL_CHECK_STATE_KEY,
  OFFICIAL_FETCH_STATE_KEY,
  MAX_OFFICIAL_RESPONSE_BYTES,
  OFFICIAL_FETCH_TIMEOUT_MS,
  OFFICIAL_NEWS_URL,
  NewsArchiveError,
  buildBackupKeys,
  fetchOfficialNews,
  readArchive,
  readArchiveDocument,
  updateNewsArchive,
  updateOfficialCheckState,
} from "../news-archive";
import { parseJapaneseNewsDate, MIN_OFFICIAL_ENTRY_COUNT } from "../news-data";

const createNews = (id: number) => ({
  id,
  targetUrl: `/info/${id}`,
  title: `お知らせ${id}`,
  newsDate: "2026年08月01日 12時00分00秒",
  updated: "2026年08月01日 12時00分00秒",
});

const createDocument = (count: number) => ({
  news: Array.from({ length: count }, (_, index) => createNews(index + 1)),
});

const createObject = (value: unknown, etag: string): R2ObjectBody => {
  const text = JSON.stringify(value);
  return {
    etag,
    text: async () => text,
    get body() {
      return streamFromChunks([new TextEncoder().encode(text)]);
    },
  } as unknown as R2ObjectBody;
};

const createBucket = (objects: Record<string, R2ObjectBody>): R2Bucket =>
  ({
    get: async (key: string) => objects[key] ?? null,
  }) as unknown as R2Bucket;

const createResponse = (
  body: ReadableStream<Uint8Array> | null,
  headers: HeadersInit = {},
  ok = true,
  status = ok ? 200 : 503,
) =>
  ({
    ok,
    status,
    headers: new Headers(headers),
    body,
  }) as unknown as Response;

const streamFromChunks = (chunks: Uint8Array[], onCancel?: () => void) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
    cancel() {
      onCancel?.();
    },
  });

type FakeStoredObject = { text: string; etag: string };
type PutOptions = {
  onlyIf?: R2Conditional;
  httpMetadata?: R2PutOptions["httpMetadata"];
};
type PutCall = {
  key: string;
  value: unknown;
  options?: PutOptions;
};

const createMutableBucket = (
  label: string,
  initial: Record<string, FakeStoredObject>,
  timeline: string[],
  options: {
    failPutKeys?: Set<string>;
    putErrors?: Map<string, unknown>;
    concurrentPutObjects?: Map<string, FakeStoredObject>;
    putErrorsAfterConcurrentPutObjects?: Map<string, unknown>;
    nullPutKeys?: Set<string>;
    putCalls?: PutCall[];
    checkStatePutCalls?: PutCall[];
    headCalls?: string[];
  } = {},
) => {
  const objects = new Map(Object.entries(initial));
  let nextEtag = 0;
  const toBody = (object: FakeStoredObject) =>
    ({
      etag: object.etag,
      text: async () => object.text,
      get body() {
        return streamFromChunks([new TextEncoder().encode(object.text)]);
      },
    }) as unknown as R2ObjectBody;
  const bucket = {
    get: async (key: string, getOptions?: { onlyIf?: Record<string, string> }) => {
      if (key !== OFFICIAL_FETCH_STATE_KEY && key !== OFFICIAL_CHECK_STATE_KEY) {
        timeline.push(`${label}:get:${key}`);
      }
      const object = objects.get(key);
      if (!object) return null;
      const onlyIf = getOptions?.onlyIf;
      if (onlyIf?.etagMatches && object.etag !== onlyIf.etagMatches) {
        return { etag: object.etag } as unknown as R2Object;
      }
      return toBody(object);
    },
    head: async (key: string) => {
      options.headCalls?.push(key);
      const object = objects.get(key);
      return object ? ({ etag: object.etag } as unknown as R2Object) : null;
    },
    put: async (key: string, value: unknown, putOptions?: PutOptions) => {
      if (key !== OFFICIAL_CHECK_STATE_KEY) timeline.push(`${label}:put:${key}`);
      const putCall = { key, value, options: putOptions };
      if (key === OFFICIAL_CHECK_STATE_KEY) options.checkStatePutCalls?.push(putCall);
      else options.putCalls?.push(putCall);
      if (options.putErrors?.has(key)) throw options.putErrors.get(key);
      if (options.failPutKeys?.has(key)) throw new Error(`put failed: ${key}`);
      if (options.nullPutKeys?.has(key)) return null;
      const concurrentObject = options.concurrentPutObjects?.get(key);
      if (concurrentObject) objects.set(key, concurrentObject);
      if (options.putErrorsAfterConcurrentPutObjects?.has(key)) {
        throw options.putErrorsAfterConcurrentPutObjects.get(key);
      }
      const existing = objects.get(key);
      const onlyIf = putOptions?.onlyIf;
      if (onlyIf) {
        if (onlyIf.etagMatches && (!existing || existing.etag !== onlyIf.etagMatches)) {
          return null;
        }
        if (
          onlyIf.etagDoesNotMatch === "*"
            ? existing !== undefined
            : existing?.etag === onlyIf.etagDoesNotMatch
        ) {
          return null;
        }
      }
      const etag = `${label}-etag-${nextEtag++}`;
      objects.set(key, { text: typeof value === "string" ? value : "", etag });
      return { etag } as unknown as R2Object;
    },
  };
  return bucket as unknown as R2Bucket;
};

const createTransactionFetcher = (document: unknown) => async () =>
  createResponse(streamFromChunks([new TextEncoder().encode(JSON.stringify(document))]));

const createTransactionCache = (timeline: string[], shouldFail = false) =>
  ({
    delete: async (key: string) => {
      timeline.push(`cache:delete:${key}`);
      if (shouldFail) throw new Error("cache delete failed");
    },
  }) as unknown as KVNamespace;

const createLogger = () => {
  const logs: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  return {
    logger: {
      log: (event: Record<string, unknown>) => logs.push(event),
      error: (event: Record<string, unknown>) => errors.push(event),
    },
    logs,
    errors,
  };
};

const transactionNowMs = parseJapaneseNewsDate("2026年08月01日 12時00分00秒");
const asStoredObject = (value: unknown, etag: string): FakeStoredObject => ({
  text: JSON.stringify(value),
  etag,
});

const expectCreateIfAbsent = (onlyIf: PutOptions["onlyIf"]) => {
  expect(onlyIf).toEqual({ etagDoesNotMatch: "*" });
};

const createSortedDocument = (count: number) => ({
  news: createDocument(count).news.reverse(),
});

describe("アーカイブ読み込み", () => {
  it("currentがあればlegacyを読まず、etagを保持する", async () => {
    const calls: string[] = [];
    const bucket = {
      get: async (key: string) => {
        calls.push(key);
        if (key === CURRENT_ARCHIVE_KEY) return createObject(createDocument(1), "current-etag");
        return createObject(createDocument(1), "legacy-etag");
      },
    } as unknown as R2Bucket;
    const result = await readArchive(bucket);
    expect(result.sourceKey).toBe(CURRENT_ARCHIVE_KEY);
    expect(result.etag).toBe("current-etag");
    expect(result.currentExists).toBe(true);
    expect(calls).toEqual([CURRENT_ARCHIVE_KEY]);
  });

  it("current欠落時だけlegacyへfallbackし、legacyのetagを使わない", async () => {
    const result = await readArchive(
      createBucket({ [LEGACY_ARCHIVE_KEY]: createObject(createDocument(1), "legacy-etag") }),
    );
    expect(result.sourceKey).toBe(LEGACY_ARCHIVE_KEY);
    expect(result.etag).toBeNull();
    expect(result.currentExists).toBe(false);
  });

  it("API用読み込みはdocumentとsource情報だけを返す", async () => {
    const result = await readArchiveDocument(
      createBucket({ [CURRENT_ARCHIVE_KEY]: createObject(createDocument(1), "current-etag") }),
    );
    expect(result.document.news).toHaveLength(1);
    expect(result.sourceKey).toBe(CURRENT_ARCHIVE_KEY);
    expect(result.etag).toBe("current-etag");
    expect(result.currentExists).toBe(true);
    expect(result).not.toHaveProperty("normalizedJson");
    expect(result).not.toHaveProperty("digest");
  });

  it("currentが不正ならlegacyへfallbackしない", async () => {
    const calls: string[] = [];
    const bucket = {
      get: async (key: string) => {
        calls.push(key);
        if (key === CURRENT_ARCHIVE_KEY) return createObject({ news: [{ id: 1 }] }, "bad-etag");
        return createObject(createDocument(1), "legacy-etag");
      },
    } as unknown as R2Bucket;
    await expect(readArchive(bucket)).rejects.toMatchObject({ stage: "archive-read" });
    expect(calls).toEqual([CURRENT_ARCHIVE_KEY]);
  });

  it("currentの日時は通常経路で再検証しない", async () => {
    const document = createDocument(1);
    document.news[0].newsDate = "保存時に検証済み";
    const result = await readArchive(
      createBucket({ [CURRENT_ARCHIVE_KEY]: createObject(document, "current-etag") }),
    );
    expect(result.document.news[0].newsDate).toBe("保存時に検証済み");
  });

  it("currentのR2取得失敗時はlegacyへfallbackしない", async () => {
    const calls: string[] = [];
    const bucket = {
      get: async (key: string) => {
        calls.push(key);
        if (key === CURRENT_ARCHIVE_KEY) throw new Error("current get failed");
        return createObject(createDocument(1), "legacy-etag");
      },
    } as unknown as R2Bucket;

    await expect(readArchive(bucket)).rejects.toMatchObject({
      stage: "archive-read",
      details: {
        sourceKey: CURRENT_ARCHIVE_KEY,
        originalError: { name: "Error", message: "current get failed" },
      },
    });
    expect(calls).toEqual([CURRENT_ARCHIVE_KEY]);
  });

  it("archive-readの汎用Errorも秘密値を除去して記録する", async () => {
    const bucket = {
      get: async () => {
        throw new Error(
          "request https://example.com/private?token=read-secret Authorization: Bearer auth-secret",
        );
      },
    } as unknown as R2Bucket;

    await expect(readArchive(bucket)).rejects.toMatchObject({
      stage: "archive-read",
      details: {
        sourceKey: CURRENT_ARCHIVE_KEY,
        originalError: {
          name: "Error",
          message: "request [REDACTED_URL] Authorization: [REDACTED]",
        },
      },
    });
  });

  it("current本文の読み込み失敗時はlegacyへfallbackしない", async () => {
    const calls: string[] = [];
    const bucket = {
      get: async (key: string) => {
        calls.push(key);
        return {
          etag: "current-etag",
          text: async () => Promise.reject(new Error("current text failed")),
        } as unknown as R2ObjectBody;
      },
    } as unknown as R2Bucket;

    await expect(readArchive(bucket)).rejects.toMatchObject({
      stage: "archive-read",
      details: {
        sourceKey: CURRENT_ARCHIVE_KEY,
        originalError: { name: "Error", message: "current text failed" },
      },
    });
    expect(calls).toEqual([CURRENT_ARCHIVE_KEY]);
  });

  it("currentとlegacyがどちらも欠落している場合はarchive-readで失敗する", async () => {
    await expect(readArchive(createBucket({}))).rejects.toMatchObject({
      stage: "archive-read",
      details: { sourceKey: LEGACY_ARCHIVE_KEY },
    });
  });

  it("legacyのR2取得失敗をarchive-readへ変換する", async () => {
    const bucket = {
      get: async (key: string) => {
        if (key === CURRENT_ARCHIVE_KEY) return null;
        throw new Error("legacy get failed");
      },
    } as unknown as R2Bucket;

    await expect(readArchive(bucket)).rejects.toMatchObject({
      stage: "archive-read",
      details: {
        sourceKey: LEGACY_ARCHIVE_KEY,
        originalError: { name: "Error", message: "legacy get failed" },
      },
    });
  });
});

describe("公式レスポンス取得", () => {
  const officialJson = () =>
    new TextEncoder().encode(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT)));

  it("非2xx、bodyなし、不正Content-Lengthを本文処理前に拒否する", async () => {
    const emptyStream = streamFromChunks([]);
    await expect(
      fetchOfficialNews(async () => createResponse(emptyStream, {}, false)),
    ).rejects.toMatchObject({
      stage: "official-fetch",
    });
    await expect(fetchOfficialNews(async () => createResponse(null))).rejects.toMatchObject({
      stage: "official-fetch",
    });
    let readerCalled = false;
    const body = {
      getReader: () => {
        readerCalled = true;
        return streamFromChunks([]).getReader();
      },
    } as unknown as ReadableStream<Uint8Array>;
    await expect(
      fetchOfficialNews(async () => createResponse(body, { "content-length": "1,2" })),
    ).rejects.toMatchObject({ stage: "official-fetch" });
    expect(readerCalled).toBe(false);
  });

  it("Content-Length超過をreader取得前に拒否する", async () => {
    let readerCalled = false;
    const body = {
      getReader: () => {
        readerCalled = true;
        return streamFromChunks([]).getReader();
      },
    } as unknown as ReadableStream<Uint8Array>;
    await expect(
      fetchOfficialNews(async () =>
        createResponse(body, { "content-length": String(MAX_OFFICIAL_RESPONSE_BYTES + 1) }),
      ),
    ).rejects.toMatchObject({ stage: "official-fetch" });
    expect(readerCalled).toBe(false);
  });

  it("Content-LengthなしでもUTF-8境界をまたぐchunkを読み込む", async () => {
    const bytes = officialJson();
    const split = bytes.findIndex((byte) => byte >= 0x80) + 1;
    const chunks = [bytes.slice(0, split), bytes.slice(split)];
    const result = await fetchOfficialNews(async () => createResponse(streamFromChunks(chunks)));
    expect(result.status).toBe("modified");
    if (result.status !== "modified") throw new Error("modified response expected");
    expect(result.byteLength).toBe(bytes.byteLength);
    expect(result.document.news).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(OFFICIAL_NEWS_URL).toBe("https://kemono-friends-3.jp/info/all/entries.txt");
  });

  it("上限超過時にstreamをcancelする", async () => {
    let cancelled = false;
    const overLimit = new Uint8Array(MAX_OFFICIAL_RESPONSE_BYTES + 1);
    const stream = streamFromChunks([overLimit]);
    const reader = stream.getReader();
    const body = {
      getReader: () => ({
        read: reader.read.bind(reader),
        cancel: async () => {
          cancelled = true;
          await reader.cancel();
        },
        releaseLock: reader.releaseLock.bind(reader),
      }),
    } as unknown as ReadableStream<Uint8Array>;
    await expect(fetchOfficialNews(async () => createResponse(body))).rejects.toMatchObject({
      stage: "official-fetch",
    });
    expect(cancelled).toBe(true);
  });

  it("公式レスポンス本文が停止した場合はタイムアウトする", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null = null;
      const fetchPromise = fetchOfficialNews(async (_input, init) => {
        signal = init?.signal ?? null;
        return createResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            },
          }),
        );
      });

      expect(signal).toBeInstanceOf(AbortSignal);
      const rejection = expect(fetchPromise).rejects.toMatchObject({ stage: "official-fetch" });
      await vi.advanceTimersByTimeAsync(OFFICIAL_FETCH_TIMEOUT_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("不正な公式documentをofficial-parseとして拒否する", async () => {
    const invalidJson = new TextEncoder().encode(JSON.stringify({ news: [{ id: 1 }] }));
    await expect(
      fetchOfficialNews(async () => createResponse(streamFromChunks([invalidJson]))),
    ).rejects.toMatchObject({ stage: "official-parse" });
  });

  it("network、stream、不正JSONの失敗stageを保持する", async () => {
    await expect(
      fetchOfficialNews(async () => Promise.reject(new Error("network failed"))),
    ).rejects.toMatchObject({ stage: "official-fetch" });

    const failedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream failed"));
      },
    });
    await expect(fetchOfficialNews(async () => createResponse(failedStream))).rejects.toMatchObject(
      {
        stage: "official-fetch",
      },
    );

    const invalidJson = new TextEncoder().encode("not-json");
    await expect(
      fetchOfficialNews(async () => createResponse(streamFromChunks([invalidJson]))),
    ).rejects.toMatchObject({ stage: "official-parse" });
  });

  it("strong ETagを返し、条件付き304では本文readerを呼ばない", async () => {
    const bytes = officialJson();
    const checkedAt = "2026-08-09T12:34:56.789Z";
    const requestHeaders: Headers[] = [];
    let readerCalled = false;
    const body = {
      getReader: () => {
        readerCalled = true;
        return streamFromChunks([bytes]).getReader();
      },
    } as unknown as ReadableStream<Uint8Array>;
    const result = await fetchOfficialNews(
      async (_input, init) => {
        requestHeaders.push(new Headers(init?.headers));
        return createResponse(body, { etag: '"source-etag"' }, false, 304);
      },
      { ifNoneMatch: '"source-etag"', clock: () => Date.parse(checkedAt) },
    );
    expect(result).toEqual({
      status: "not-modified",
      byteLength: 0,
      officialEtag: '"source-etag"',
      conditionalRequestUsed: true,
      checkedAt,
    });
    expect(requestHeaders[0].get("If-None-Match")).toBe('"source-etag"');
    expect(readerCalled).toBe(false);
  });

  it("200の公式ETagと公式確認時刻を結果へ保持する", async () => {
    const checkedAt = "2026-08-09T12:34:56.789Z";
    const result = await fetchOfficialNews(
      async () => createResponse(streamFromChunks([officialJson()]), { etag: '"source-etag"' }),
      { clock: () => Date.parse(checkedAt) },
    );
    expect(result.status).toBe("modified");
    if (result.status !== "modified") throw new Error("modified response expected");
    expect(result.officialEtag).toBe('"source-etag"');
    expect(result.checkedAt).toBe(checkedAt);
  });

  it("空のstrong ETagを条件付き取得へ使用する", async () => {
    const checkedAt = "2026-08-09T12:34:56.789Z";
    const requestHeaders: Headers[] = [];
    const result = await fetchOfficialNews(
      async (_input, init) => {
        requestHeaders.push(new Headers(init?.headers));
        return createResponse(null, { etag: '""' }, false, 304);
      },
      { ifNoneMatch: '""', clock: () => Date.parse(checkedAt) },
    );
    expect(result).toEqual({
      status: "not-modified",
      byteLength: 0,
      officialEtag: '""',
      conditionalRequestUsed: true,
      checkedAt,
    });
    expect(requestHeaders[0].get("If-None-Match")).toBe('""');
  });

  it.each(['"bad value"', '"a","b"', '"😀"'])(
    "不正なETag %s はIf-None-Matchへ送らない",
    async (invalidEtag) => {
      const requestHeaders: Headers[] = [];
      const result = await fetchOfficialNews(
        async (_input, init) => {
          requestHeaders.push(new Headers(init?.headers));
          return createResponse(streamFromChunks([officialJson()]));
        },
        { ifNoneMatch: invalidEtag },
      );
      expect(result.status).toBe("modified");
      expect(requestHeaders[0].get("If-None-Match")).toBeNull();
    },
  );
});

describe("バックアップキー", () => {
  it("JSTの日付とUTCのファイル名を分けて生成する", () => {
    const timeMs = Date.parse("2026-08-01T18:15:00Z");
    expect(buildBackupKeys(timeMs)).toEqual({
      dailyKey: "daily/2026/08/02/2026-08-01T18-15-00Z.json",
      monthlyKey: "monthly/2026-08.json",
    });
    expect(() => buildBackupKeys(Number.NaN)).toThrow(NewsArchiveError);
  });
});

describe("公式確認時刻state", () => {
  it("既存より古い確認時刻でstateを巻き戻さない", async () => {
    const previousCheckedAt = "2026-08-09T12:00:00.000Z";
    const newerCheckedAt = "2026-08-09T12:34:56.789Z";
    const checkStatePutCalls: PutCall[] = [];
    const bucket = createMutableBucket(
      "data",
      {
        [OFFICIAL_CHECK_STATE_KEY]: asStoredObject(
          { version: 1, checkedAt: previousCheckedAt },
          "check-state-etag",
        ),
      },
      [],
      { checkStatePutCalls },
    );

    expect(await updateOfficialCheckState(bucket, previousCheckedAt)).toBe("unchanged");
    expect(await updateOfficialCheckState(bucket, newerCheckedAt)).toBe("saved");
    expect(checkStatePutCalls).toHaveLength(1);
    expect(JSON.parse(String(checkStatePutCalls[0].value))).toEqual({
      version: 1,
      checkedAt: newerCheckedAt,
    });
  });
});

describe("アーカイブ更新トランザクション", () => {
  const createDependencies = (
    current: FakeStoredObject | null,
    official = createDocument(MIN_OFFICIAL_ENTRY_COUNT),
    backupOptions: {
      failPutKeys?: Set<string>;
      putErrors?: Map<string, unknown>;
      concurrentPutObjects?: Map<string, FakeStoredObject>;
      putErrorsAfterConcurrentPutObjects?: Map<string, unknown>;
      nullPutKeys?: Set<string>;
      initial?: Record<string, FakeStoredObject>;
      putCalls?: PutCall[];
      headCalls?: string[];
    } = {},
    cacheFailure = false,
    dataOptions: {
      failPutKeys?: Set<string>;
      putErrors?: Map<string, unknown>;
      nullPutKeys?: Set<string>;
      putCalls?: PutCall[];
      checkStatePutCalls?: PutCall[];
      initial?: Record<string, FakeStoredObject>;
    } = {},
  ) => {
    const timeline: string[] = [];
    const dataInitial: Record<string, FakeStoredObject> = {
      ...dataOptions.initial,
      ...(current ? { [CURRENT_ARCHIVE_KEY]: current } : {}),
    };
    const dataBucket = createMutableBucket("data", dataInitial, timeline, dataOptions);
    const backupBucket = createMutableBucket(
      "backup",
      backupOptions.initial ?? {},
      timeline,
      backupOptions,
    );
    const cache = createTransactionCache(timeline, cacheFailure);
    const logger = createLogger();
    return {
      dependencies: {
        dataBucket,
        backupBucket,
        cache,
        fetcher: createTransactionFetcher(official),
        nowMs: transactionNowMs,
        clock: (() => {
          let value = 0;
          return () => value++;
        })(),
        logger: logger.logger,
      },
      timeline,
      logger,
    };
  };

  it("daily、current、KV、monthlyの順に更新し、ETag条件を使う", async () => {
    const originalText = `{ "news": ${JSON.stringify(createDocument(1).news)} }`;
    const dataPuts: PutCall[] = [];
    const backupPuts: PutCall[] = [];
    const setup = createDependencies(
      { text: originalText, etag: "current-read-etag" },
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      { putCalls: backupPuts },
      false,
      { putCalls: dataPuts },
    );
    const result = await updateNewsArchive(setup.dependencies);
    expect(result.updated).toBe(true);
    expect(result.dailyBackupKey).toMatch(/^daily\/2026\/08\/01\//);
    expect(result.monthlyBackupKey).toBe("monthly/2026-08.json");
    expect(result.monthlyBackupStatus).toBe("created");
    expect(result).not.toHaveProperty("digest");
    expect(setup.timeline).toEqual([
      `data:get:${CURRENT_ARCHIVE_KEY}`,
      `backup:put:${result.dailyBackupKey}`,
      `data:put:${CURRENT_ARCHIVE_KEY}`,
      "cache:delete:kf3-news-archive-snapshot",
      "cache:delete:kf3-news",
      `backup:put:${result.monthlyBackupKey}`,
    ]);
    expect(setup.logger.logs[0]).toMatchObject({
      event: "news_archive_update",
      trigger: "manual",
      updateStatus: "updated",
    });
    expect(setup.logger.errors).toHaveLength(0);
    expect(dataPuts).toEqual([
      {
        key: CURRENT_ARCHIVE_KEY,
        value: expect.any(String),
        options: {
          onlyIf: { etagMatches: "current-read-etag" },
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        },
      },
    ]);
    expect(backupPuts).toHaveLength(2);
    expect(backupPuts[0]).toMatchObject({
      key: result.dailyBackupKey,
      value: originalText,
      options: {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      },
    });
    expectCreateIfAbsent(backupPuts[0].options?.onlyIf);
    expect(backupPuts[1]).toMatchObject({
      key: result.monthlyBackupKey,
      value: dataPuts[0].value,
      options: {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      },
    });
    expectCreateIfAbsent(backupPuts[1].options?.onlyIf);
  });

  it("表示KV invalidationを無効にしてもarchiveとbackupを更新する", async () => {
    const setup = createDependencies(asStoredObject(createDocument(1), "current-read-etag"));

    const result = await updateNewsArchive({
      ...setup.dependencies,
      trigger: "queue",
      invalidateDisplayCache: false,
    });

    expect(result.updated).toBe(true);
    expect(setup.timeline).toEqual([
      `data:get:${CURRENT_ARCHIVE_KEY}`,
      `backup:put:${result.dailyBackupKey}`,
      `data:put:${CURRENT_ARCHIVE_KEY}`,
      "cache:delete:kf3-news-archive-snapshot",
      `backup:put:${result.monthlyBackupKey}`,
    ]);
  });

  it("stateとcurrentのETagが一致すると公式304を採用し、本文処理を省略する", async () => {
    const monthlyKey = buildBackupKeys(transactionNowMs).monthlyKey;
    const requestHeaders: string[] = [];
    const setup = createDependencies(
      asStoredObject(createSortedDocument(MIN_OFFICIAL_ENTRY_COUNT), "current-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      { initial: { [monthlyKey]: asStoredObject(createDocument(1), "monthly-etag") } },
      false,
      {
        initial: {
          [OFFICIAL_FETCH_STATE_KEY]: asStoredObject(
            { version: 1, officialEtag: '"official-etag"', currentEtag: "current-etag" },
            "state-etag",
          ),
        },
      },
    );
    const result = await updateNewsArchive({
      ...setup.dependencies,
      fetcher: async (_input, init) => {
        requestHeaders.push(new Headers(init?.headers).get("If-None-Match") ?? "");
        return createResponse(null, { etag: '"official-etag"' }, false, 304);
      },
    });
    expect(result.officialFetchStatus).toBe("not-modified");
    expect(result.officialBodyProcessed).toBe(false);
    expect(result.monthlyBackupStatus).toBe("existing");
    expect(requestHeaders).toEqual(['"official-etag"']);
    expect(setup.timeline).toEqual([`data:put:${OFFICIAL_FETCH_STATE_KEY}`]);
    const stateObject = await setup.dependencies.dataBucket.get(OFFICIAL_FETCH_STATE_KEY);
    expect(JSON.parse((await stateObject?.text()) ?? "null")).toMatchObject({
      version: 2,
      officialEtag: '"official-etag"',
      currentEtag: "current-etag",
      checkedAt: expect.any(String),
    });
  });

  it("304でも公式確認時刻をstateへ更新する", async () => {
    const previousCheckedAt = "2026-08-09T12:00:00.000Z";
    const checkedAt = "2026-08-09T12:34:56.789Z";
    const monthlyKey = buildBackupKeys(transactionNowMs).monthlyKey;
    const dataPuts: PutCall[] = [];
    const checkStatePuts: PutCall[] = [];
    const setup = createDependencies(
      asStoredObject(createSortedDocument(MIN_OFFICIAL_ENTRY_COUNT), "current-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      { initial: { [monthlyKey]: asStoredObject(createDocument(1), "monthly-etag") } },
      false,
      {
        putCalls: dataPuts,
        checkStatePutCalls: checkStatePuts,
        initial: {
          [OFFICIAL_FETCH_STATE_KEY]: asStoredObject(
            {
              version: 2,
              officialEtag: '"official-etag"',
              currentEtag: "current-etag",
              checkedAt: previousCheckedAt,
            },
            "state-etag",
          ),
        },
      },
    );
    const result = await updateNewsArchive({
      ...setup.dependencies,
      clock: () => Date.parse(checkedAt),
      fetcher: async () => createResponse(null, { etag: '"official-etag"' }, false, 304),
    });

    expect(result.officialCheckedAt).toBe(checkedAt);
    expect(result.officialCheckStateStatus).toBe("saved");
    expect(result.etagStateStatus).toBe("saved");
    expect(dataPuts).toHaveLength(1);
    expect(JSON.parse(String(dataPuts[0].value))).toEqual({
      version: 2,
      officialEtag: '"official-etag"',
      currentEtag: "current-etag",
      checkedAt,
    });
    expect(checkStatePuts).toHaveLength(1);
    expect(JSON.parse(String(checkStatePuts[0].value))).toEqual({
      version: 1,
      checkedAt,
    });
  });

  it("304でmonthlyが欠けている場合はcurrentのraw bodyを保存する", async () => {
    const monthlyKey = buildBackupKeys(transactionNowMs).monthlyKey;
    const backupPuts: PutCall[] = [];
    const headCalls: string[] = [];
    const setup = createDependencies(
      asStoredObject(createSortedDocument(MIN_OFFICIAL_ENTRY_COUNT), "current-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      { putCalls: backupPuts, headCalls },
      false,
      {
        initial: {
          [OFFICIAL_FETCH_STATE_KEY]: asStoredObject(
            { version: 1, officialEtag: '"official-etag"', currentEtag: "current-etag" },
            "state-etag",
          ),
        },
      },
    );
    const result = await updateNewsArchive({
      ...setup.dependencies,
      fetcher: async () => createResponse(null, { etag: '"official-etag"' }, false, 304),
    });
    expect(result.officialFetchStatus).toBe("not-modified");
    expect(result.monthlyBackupStatus).toBe("created");
    expect(backupPuts).toHaveLength(1);
    expect(backupPuts[0].key).toBe(monthlyKey);
    expect(backupPuts[0].value).toBeInstanceOf(Object);
    expect(headCalls).toEqual([monthlyKey]);
    expect(setup.timeline).toContain(`data:get:${CURRENT_ARCHIVE_KEY}`);
  });

  it.each(['"bad value"', '"a","b"', '"😀"'])(
    "不正なstateの公式ETag %s は条件なしGETへ戻る",
    async (invalidEtag) => {
      const requestHeaders: Headers[] = [];
      const setup = createDependencies(
        asStoredObject(createDocument(1), "current-etag"),
        createDocument(MIN_OFFICIAL_ENTRY_COUNT),
        {},
        false,
        {
          initial: {
            [OFFICIAL_FETCH_STATE_KEY]: asStoredObject(
              { version: 1, officialEtag: invalidEtag, currentEtag: "current-etag" },
              "state-etag",
            ),
          },
        },
      );
      const result = await updateNewsArchive({
        ...setup.dependencies,
        fetcher: async (_input, init) => {
          requestHeaders.push(new Headers(init?.headers));
          return createResponse(
            streamFromChunks([
              new TextEncoder().encode(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT))),
            ]),
            { etag: '"official-etag"' },
          );
        },
      });
      expect(result.officialFetchStatus).toBe("modified");
      expect(requestHeaders[0].get("If-None-Match")).toBeNull();
    },
  );

  it("stateがない場合はIf-None-Matchを送らず200経路を実行する", async () => {
    const requestHeaders: Headers[] = [];
    const setup = createDependencies(asStoredObject(createDocument(1), "current-etag"));
    const result = await updateNewsArchive({
      ...setup.dependencies,
      fetcher: async (_input, init) => {
        requestHeaders.push(new Headers(init?.headers));
        return createResponse(
          streamFromChunks([
            new TextEncoder().encode(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT))),
          ]),
          {
            etag: '"official-etag"',
          },
        );
      },
    });
    expect(result.officialFetchStatus).toBe("modified");
    expect(requestHeaders[0].get("If-None-Match")).toBeNull();
  });

  it("200経路ではmonthly完了後に公式ETagと確認時刻stateを保存する", async () => {
    const dataPuts: PutCall[] = [];
    const checkStatePuts: PutCall[] = [];
    const setup = createDependencies(
      asStoredObject(createDocument(1), "current-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      {},
      false,
      { putCalls: dataPuts, checkStatePutCalls: checkStatePuts },
    );
    const result = await updateNewsArchive({
      ...setup.dependencies,
      fetcher: async () =>
        createResponse(
          streamFromChunks([
            new TextEncoder().encode(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT))),
          ]),
          { etag: '"official-etag"' },
        ),
    });
    expect(result.etagStateStatus).toBe("saved");
    expect(result.officialCheckStateStatus).toBe("saved");
    expect(checkStatePuts).toHaveLength(1);
    expect(JSON.parse(String(checkStatePuts[0].value))).toMatchObject({
      version: 1,
      checkedAt: expect.any(String),
    });
    expect(dataPuts.map((call) => call.key)).toEqual([
      CURRENT_ARCHIVE_KEY,
      OFFICIAL_FETCH_STATE_KEY,
    ]);
    expect(setup.timeline.indexOf(`data:put:${OFFICIAL_FETCH_STATE_KEY}`)).toBeGreaterThan(
      setup.timeline.indexOf(`backup:put:${result.monthlyBackupKey}`),
    );
  });

  it("公式ETagがweakならstateを保存しない", async () => {
    const dataPuts: PutCall[] = [];
    const setup = createDependencies(
      asStoredObject(createDocument(1), "current-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      {},
      false,
      { putCalls: dataPuts },
    );
    const result = await updateNewsArchive({
      ...setup.dependencies,
      fetcher: async () =>
        createResponse(
          streamFromChunks([
            new TextEncoder().encode(JSON.stringify(createDocument(MIN_OFFICIAL_ENTRY_COUNT))),
          ]),
          {
            etag: 'W/"weak-etag"',
          },
        ),
    });
    expect(result.etagStateStatus).toBe("unavailable");
    expect(dataPuts.some((call) => call.key === OFFICIAL_FETCH_STATE_KEY)).toBe(false);
  });

  it("daily backup失敗時はcurrentとKVを変更しない", async () => {
    const expectedDailyKey = buildBackupKeys(transactionNowMs).dailyKey;
    const failingSetup = createDependencies(
      asStoredObject(createDocument(1), "current-read-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      { failPutKeys: new Set([expectedDailyKey]) },
    );
    await expect(updateNewsArchive(failingSetup.dependencies)).rejects.toMatchObject({
      stage: "daily-backup",
    });
    expect(failingSetup.timeline).toEqual([
      `data:get:${CURRENT_ARCHIVE_KEY}`,
      `backup:put:${expectedDailyKey}`,
    ]);
    expect(failingSetup.logger.errors[0]).toMatchObject({
      event: "news_archive_update_failed",
      stage: "daily-backup",
    });
  });

  it("daily backupキーの競合時は既存objectを読み直さず失敗する", async () => {
    const dailyKey = buildBackupKeys(transactionNowMs).dailyKey;
    const setup = createDependencies(
      asStoredObject(createDocument(1), "current-read-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      {
        initial: {
          [dailyKey]: { text: "existing daily", etag: "daily-etag" },
        },
      },
    );
    await expect(updateNewsArchive(setup.dependencies)).rejects.toMatchObject({
      stage: "daily-backup",
      details: { key: dailyKey },
    });
    expect(setup.timeline).toEqual([`data:get:${CURRENT_ARCHIVE_KEY}`, `backup:put:${dailyKey}`]);
  });

  it("currentのETag競合時はKVとmonthlyへ進まない", async () => {
    const expectedDailyKey = buildBackupKeys(transactionNowMs).dailyKey;
    const conflictSetup = createDependencies(
      asStoredObject(createDocument(1), "current-read-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      {},
      false,
      { nullPutKeys: new Set([CURRENT_ARCHIVE_KEY]) },
    );
    await expect(updateNewsArchive(conflictSetup.dependencies)).rejects.toMatchObject({
      stage: "etag-conflict",
    });
    expect(conflictSetup.timeline).toEqual([
      `data:get:${CURRENT_ARCHIVE_KEY}`,
      `backup:put:${expectedDailyKey}`,
      `data:put:${CURRENT_ARCHIVE_KEY}`,
    ]);
    expect(conflictSetup.logger.errors[0]).toMatchObject({ stage: "etag-conflict" });
  });

  it("currentのput失敗時はKVとmonthlyへ進まない", async () => {
    const expectedDailyKey = buildBackupKeys(transactionNowMs).dailyKey;
    const setup = createDependencies(
      asStoredObject(createDocument(1), "current-read-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      {},
      false,
      { failPutKeys: new Set([CURRENT_ARCHIVE_KEY]) },
    );
    await expect(updateNewsArchive(setup.dependencies)).rejects.toMatchObject({
      stage: "archive-write",
    });
    expect(setup.timeline).toEqual([
      `data:get:${CURRENT_ARCHIVE_KEY}`,
      `backup:put:${expectedDailyKey}`,
      `data:put:${CURRENT_ARCHIVE_KEY}`,
    ]);
    expect(setup.logger.errors[0]).toMatchObject({ stage: "archive-write" });
  });

  it("KV削除失敗時はcurrentを巻き戻さず、monthlyへ進まない", async () => {
    const expectedDailyKey = buildBackupKeys(transactionNowMs).dailyKey;
    const setup = createDependencies(
      asStoredObject(createDocument(1), "current-read-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      {},
      true,
    );
    await expect(updateNewsArchive(setup.dependencies)).rejects.toMatchObject({
      stage: "cache-delete",
    });
    expect(setup.timeline).toEqual([
      `data:get:${CURRENT_ARCHIVE_KEY}`,
      `backup:put:${expectedDailyKey}`,
      `data:put:${CURRENT_ARCHIVE_KEY}`,
      "cache:delete:kf3-news-archive-snapshot",
      "cache:delete:kf3-news",
    ]);
    expect(setup.logger.errors[0]).toMatchObject({ stage: "cache-delete" });
  });

  it("currentと統合結果が同じなら本番更新を省略し、monthlyだけ補完する", async () => {
    const setup = createDependencies(
      asStoredObject(createSortedDocument(MIN_OFFICIAL_ENTRY_COUNT), "current-etag"),
    );
    const result = await updateNewsArchive(setup.dependencies);
    expect(result.updated).toBe(false);
    expect(result.dailyBackupKey).toBeNull();
    expect(result.monthlyBackupStatus).toBe("created");
    expect(setup.timeline).toEqual([
      `data:get:${CURRENT_ARCHIVE_KEY}`,
      `backup:put:${result.monthlyBackupKey}`,
    ]);
  });

  it("既存monthlyの内容を通常経路で読み直さない", async () => {
    const monthlyKey = buildBackupKeys(transactionNowMs).monthlyKey;
    const setup = createDependencies(
      asStoredObject(createSortedDocument(MIN_OFFICIAL_ENTRY_COUNT), "current-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      {
        initial: {
          [monthlyKey]: { text: "invalid", etag: "monthly-etag" },
        },
      },
    );
    const result = await updateNewsArchive(setup.dependencies);
    expect(result.monthlyBackupStatus).toBe("existing");
    expect(setup.timeline).toEqual([`data:get:${CURRENT_ARCHIVE_KEY}`]);
  });

  it("current初回作成ではlegacyと同じ内容でもdailyとcurrentを作る", async () => {
    const timeline: string[] = [];
    const dataPuts: PutCall[] = [];
    const legacy = createMutableBucket(
      "data",
      {
        [LEGACY_ARCHIVE_KEY]: asStoredObject(
          createSortedDocument(MIN_OFFICIAL_ENTRY_COUNT),
          "legacy-etag",
        ),
      },
      timeline,
      { putCalls: dataPuts },
    );
    const backup = createMutableBucket("backup", {}, timeline);
    const logger = createLogger();
    const result = await updateNewsArchive({
      dataBucket: legacy,
      backupBucket: backup,
      cache: createTransactionCache(timeline),
      fetcher: createTransactionFetcher(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
      nowMs: transactionNowMs,
      logger: logger.logger,
    });
    expect(result.updated).toBe(true);
    expect(timeline[0]).toBe(`data:get:${CURRENT_ARCHIVE_KEY}`);
    expect(timeline[1]).toBe(`data:get:${LEGACY_ARCHIVE_KEY}`);
    expect(timeline).toContain(`data:put:${CURRENT_ARCHIVE_KEY}`);
    expect(timeline).toContain(`backup:put:${result.dailyBackupKey}`);
    expectCreateIfAbsent(dataPuts[0].options?.onlyIf);
  });

  it("current初回作成の競合時は既存currentを上書きしない", async () => {
    const timeline: string[] = [];
    const concurrentCurrent = asStoredObject(createDocument(2), "concurrent-etag");
    const dataBucket = createMutableBucket(
      "data",
      {
        [LEGACY_ARCHIVE_KEY]: asStoredObject(
          createSortedDocument(MIN_OFFICIAL_ENTRY_COUNT),
          "legacy-etag",
        ),
      },
      timeline,
      {
        concurrentPutObjects: new Map([[CURRENT_ARCHIVE_KEY, concurrentCurrent]]),
      },
    );
    const backupBucket = createMutableBucket("backup", {}, timeline);
    const logger = createLogger();

    await expect(
      updateNewsArchive({
        dataBucket,
        backupBucket,
        cache: createTransactionCache(timeline),
        fetcher: createTransactionFetcher(createDocument(MIN_OFFICIAL_ENTRY_COUNT)),
        nowMs: transactionNowMs,
        logger: logger.logger,
      }),
    ).rejects.toMatchObject({ stage: "etag-conflict" });

    const storedCurrent = await dataBucket.get(CURRENT_ARCHIVE_KEY);
    expect(await storedCurrent?.text()).toBe(concurrentCurrent.text);
    expect(timeline).not.toContain("cache:delete:kf3-news");
    expect(timeline).not.toContain(`backup:put:${buildBackupKeys(transactionNowMs).monthlyKey}`);
  });

  it("monthly backup失敗時はcurrentを巻き戻さず、失敗を返す", async () => {
    const current = asStoredObject(createDocument(1), "current-read-etag");
    const monthlyKey = buildBackupKeys(transactionNowMs).monthlyKey;
    const setup = createDependencies(current, createDocument(MIN_OFFICIAL_ENTRY_COUNT), {
      failPutKeys: new Set([monthlyKey]),
    });
    await expect(updateNewsArchive(setup.dependencies)).rejects.toMatchObject({
      stage: "monthly-backup",
      details: {
        key: monthlyKey,
        originalError: { name: "Error", message: `put failed: ${monthlyKey}` },
      },
    });
    expect(setup.timeline).toContain(`data:put:${CURRENT_ARCHIVE_KEY}`);
    expect(setup.timeline).toContain("cache:delete:kf3-news-archive-snapshot");
    expect(setup.timeline).toContain("cache:delete:kf3-news");
    expect(setup.timeline).toContain(`backup:put:${monthlyKey}`);
    expect(setup.logger.errors[0]).toMatchObject({
      event: "news_archive_update_failed",
      stage: "monthly-backup",
      details: {
        key: monthlyKey,
        originalError: { name: "Error", message: `put failed: ${monthlyKey}` },
      },
    });
  });

  it("monthlyの条件付きPUT競合は既存扱いにする", async () => {
    const current = asStoredObject(createDocument(1), "current-read-etag");
    const monthlyKey = buildBackupKeys(transactionNowMs).monthlyKey;
    const setup = createDependencies(current, createDocument(MIN_OFFICIAL_ENTRY_COUNT), {
      nullPutKeys: new Set([monthlyKey]),
    });
    const result = await updateNewsArchive(setup.dependencies);
    expect(result.monthlyBackupStatus).toBe("existing");
    expect(setup.timeline).toContain(`backup:put:${monthlyKey}`);
  });

  it("既存monthlyはHEADで確認してPUTせず保存済みとして扱う", async () => {
    const current = asStoredObject(createDocument(1), "current-read-etag");
    const monthlyKey = buildBackupKeys(transactionNowMs).monthlyKey;
    const headCalls: string[] = [];
    const setup = createDependencies(current, createDocument(MIN_OFFICIAL_ENTRY_COUNT), {
      initial: { [monthlyKey]: asStoredObject(createDocument(1), "monthly-etag") },
      headCalls,
    });
    const result = await updateNewsArchive(setup.dependencies);
    expect(result.monthlyBackupStatus).toBe("existing");
    expect(headCalls).toEqual([monthlyKey]);
    expect(setup.timeline).not.toContain(`backup:put:${monthlyKey}`);
    expect(setup.logger.errors).toEqual([]);
  });

  it("monthly PUTのBucket Lock競合は保存済みとして扱い、競合側の内容を保持する", async () => {
    const current = asStoredObject(createDocument(1), "current-read-etag");
    const monthlyKey = buildBackupKeys(transactionNowMs).monthlyKey;
    const concurrentMonthly = asStoredObject(createDocument(2), "locked-monthly-etag");
    const setup = createDependencies(current, createDocument(MIN_OFFICIAL_ENTRY_COUNT), {
      concurrentPutObjects: new Map([[monthlyKey, concurrentMonthly]]),
      putErrorsAfterConcurrentPutObjects: new Map([
        [monthlyKey, new Error("put: The object is locked by the bucket policy. (10069)")],
      ]),
    });
    const result = await updateNewsArchive(setup.dependencies);
    const storedMonthly = await setup.dependencies.backupBucket.get(monthlyKey);
    expect(result.monthlyBackupStatus).toBe("existing");
    expect(setup.timeline).toContain(`backup:put:${monthlyKey}`);
    expect(await storedMonthly?.text()).toBe(concurrentMonthly.text);
    expect(setup.logger.errors).toEqual([]);
  });

  it("汎用Errorの秘密値と制御文字を除去し、長さを制限する", async () => {
    const secretValues = [
      "url-secret",
      "authorization-secret",
      "api-key-secret",
      "plain-token",
      "jwt-payload-secret",
      "github_pat_exampleSecret",
    ];
    const unsafeError = new Error(
      [
        "request https://user:url-secret@example.com/path?token=url-secret",
        "Authorization: Bearer authorization-secret",
        "api_key=api-key-secret",
        "token=plain-token",
        "abcdefgh.jwt-payload-secret.ijklmnop",
        "github_pat_exampleSecret",
        "line1\r\nline2\0",
        "x".repeat(600),
      ].join(" "),
    );
    unsafeError.name = `Remote\nError${"n".repeat(120)}`;
    const setup = createDependencies(
      asStoredObject(createDocument(1), "current-read-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      {},
      false,
      { putErrors: new Map([[CURRENT_ARCHIVE_KEY, unsafeError]]) },
    );

    await expect(updateNewsArchive(setup.dependencies)).rejects.toMatchObject({
      stage: "archive-write",
    });

    const details = setup.logger.errors[0].details as Record<string, unknown>;
    const originalError = details.originalError as { name: string; message: string };
    expect(originalError.name).toHaveLength(100);
    expect(originalError.name.endsWith("…")).toBe(true);
    expect(originalError.message).toHaveLength(500);
    expect(originalError.message.endsWith("…")).toBe(true);
    expect(originalError.message).toContain("[REDACTED_URL]");
    expect(originalError.message).toContain("[REDACTED]");
    expect(originalError.message).toContain("[REDACTED_TOKEN]");
    expect(originalError.message).not.toContain("\r");
    expect(originalError.message).not.toContain("\n");
    expect(originalError.message).not.toContain("\0");
    const serialized = JSON.stringify(setup.logger.errors[0]);
    for (const secret of secretValues) expect(serialized).not.toContain(secret);
  });

  it("非Errorのthrowを文字列化せず固定値で記録する", async () => {
    const toString = vi.fn(() => "must-not-appear");
    const thrownValue = { token: "object-secret", toString };
    const setup = createDependencies(
      asStoredObject(createDocument(1), "current-read-etag"),
      createDocument(MIN_OFFICIAL_ENTRY_COUNT),
      {},
      false,
      { putErrors: new Map([[CURRENT_ARCHIVE_KEY, thrownValue]]) },
    );

    await expect(updateNewsArchive(setup.dependencies)).rejects.toMatchObject({
      stage: "archive-write",
      details: {
        originalError: {
          name: "NonErrorThrown",
          message: "A non-Error value was thrown",
        },
      },
    });
    expect(toString).not.toHaveBeenCalled();
    expect(JSON.stringify(setup.logger.errors[0])).not.toContain("object-secret");
  });

  it("公式データの失敗ではwriteとdeleteを実行しない", async () => {
    const setup = createDependencies(asStoredObject(createDocument(1), "current-read-etag"));
    const result = await updateNewsArchive({
      ...setup.dependencies,
      fetcher: async () => createResponse(streamFromChunks([]), {}, false),
    }).catch((error: unknown) => error);
    expect(result).toMatchObject({ stage: "official-fetch" });
    expect(setup.timeline).toEqual([`data:get:${CURRENT_ARCHIVE_KEY}`]);
    expect(setup.logger.errors[0]).toMatchObject({ stage: "official-fetch" });
  });
});
