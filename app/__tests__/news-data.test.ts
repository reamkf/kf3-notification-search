import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import {
  MAX_UPDATED_EXISTING_ENTRY_COUNT,
  MIN_OFFICIAL_ENTRY_COUNT,
  NewsDataError,
  canonicalizeNewsDocument,
  mergeNewsDocuments,
  mergeValidatedNewsDocument,
  normalizeNewsDocument,
  parseJapaneseNewsDate,
  projectClientNews,
  projectValidatedClientNews,
  sha256Hex,
  validateOfficialNewsDocument,
  validateParsedStoredNewsDocumentShape,
  validateStoredNewsDocument,
} from "../news-data";
import { newsArraySchema, storedNewsDocumentSchema, storedNewsSchema } from "../schema";

const createNews = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  targetUrl: `/info/${id}`,
  title: `お知らせ${id}`,
  newsDate: "2026年08月01日 12時00分00秒",
  updated: "2026年08月01日 12時00分00秒",
  ...overrides,
});

const createDocument = (
  count: number,
  overrides: Record<number, Record<string, unknown>> = {},
) => ({
  news: Array.from({ length: count }, (_, index) => createNews(index + 1, overrides[index + 1])),
});

describe("保存用スキーマ", () => {
  it("idの欠落、0、負数、小数を拒否する", () => {
    for (const id of [undefined, 0, -1, 1.5]) {
      const result = v.safeParse(storedNewsSchema, createNews(1, { id }));
      expect(result.success).toBe(false);
    }
  });

  it("安全整数の範囲外のidを拒否する", () => {
    expect(
      v.safeParse(storedNewsSchema, createNews(1, { id: Number.MAX_SAFE_INTEGER })).success,
    ).toBe(true);
    expect(
      v.safeParse(storedNewsSchema, createNews(1, { id: Number.MAX_SAFE_INTEGER + 1 })).success,
    ).toBe(false);
  });

  it("通常経路の高速検証でも安全整数の範囲外のidを拒否する", () => {
    expect(() =>
      validateParsedStoredNewsDocumentShape(
        createDocument(1, { 1: { id: Number.MAX_SAFE_INTEGER } }),
      ),
    ).not.toThrow();
    expect(() =>
      validateParsedStoredNewsDocumentShape(
        createDocument(1, { 1: { id: Number.MAX_SAFE_INTEGER + 1 } }),
      ),
    ).toThrow();
  });

  it("categoryの省略を許可し、未知フィールドを保持する", () => {
    const result = v.parse(storedNewsSchema, createNews(1, { extra: "keep" }));
    expect(result.category).toBeUndefined();
    expect(result.extra).toBe("keep");
  });

  it("保存用documentを検証する", () => {
    expect(v.parse(storedNewsDocumentSchema, { news: [createNews(1)] }).news).toHaveLength(1);
  });

  it("client用出力にcategoryを含め、未知フィールドを除外する", () => {
    const document = { news: [createNews(1, { category: "event", extra: true })] };
    const expected = [
      {
        targetUrl: "/info/1",
        title: "お知らせ1",
        newsDate: "2026年08月01日 12時00分00秒",
        updated: "2026年08月01日 12時00分00秒",
        category: "event",
      },
    ];

    expect(projectClientNews(document)).toEqual(expected);
    expect(projectValidatedClientNews(document)).toEqual(expected);
    expect(v.safeParse(newsArraySchema, expected).success).toBe(true);
  });

  it("categoryがないときはclient用出力へ含めない", () => {
    expect(projectValidatedClientNews({ news: [createNews(1)] })).toEqual([
      {
        targetUrl: "/info/1",
        title: "お知らせ1",
        newsDate: "2026年08月01日 12時00分00秒",
        updated: "2026年08月01日 12時00分00秒",
      },
    ]);
  });

  it("通常経路の構造検証では保存済み日時を再解析しない", () => {
    const document = createDocument(1, { 1: { newsDate: "invalid" } });
    expect(validateParsedStoredNewsDocumentShape(document)).toBe(document);
    expect(() => validateStoredNewsDocument(document)).toThrow();
  });

  it("スキーマエラーの詳細にはメッセージとキーのパスだけを含める", () => {
    const document = createDocument(MIN_OFFICIAL_ENTRY_COUNT, { 1: { title: 1 } });

    let error: unknown;
    try {
      validateStoredNewsDocument(document);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NewsDataError);
    if (!(error instanceof NewsDataError)) return;

    expect(error.details.issues).toEqual([
      {
        message: expect.stringContaining("Expected string"),
        path: ["news", 0, "title"],
      },
    ]);
    expect(JSON.stringify(error.details).length).toBeLessThan(500);
  });
});

describe("日本語日時", () => {
  it("JSTとして厳密に解析する", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    expect(parseJapaneseNewsDate("2026年08月01日 00時00分00秒")).toBe(
      Date.parse("2026-07-31T15:00:00.000Z"),
    );
    expect(parseJapaneseNewsDate("2024年02月29日 23時59分59秒")).toBe(
      Date.parse("2024-02-29T14:59:59.000Z"),
    );
    expect(formatter).not.toHaveBeenCalled();
    formatter.mockRestore();
  });

  it.each([
    "2023年02月29日 00時00分00秒",
    "2026年13月01日 00時00分00秒",
    "2026年08月01日 24時00分00秒",
    "2026年08月01日 00時00分00秒suffix",
  ])("不正な日時を拒否する: %s", (value) => {
    expect(() => parseJapaneseNewsDate(value)).toThrow();
  });
});

describe("公式データ検証", () => {
  it("件数、重複ID、外部originを拒否する", () => {
    expect(() =>
      validateOfficialNewsDocument(createDocument(MIN_OFFICIAL_ENTRY_COUNT - 1)),
    ).toThrow();
    expect(() => validateOfficialNewsDocument({ news: [createNews(1), createNews(1)] })).toThrow();
    expect(() =>
      validateOfficialNewsDocument(
        createDocument(MIN_OFFICIAL_ENTRY_COUNT, { 1: { targetUrl: "//other.example/news" } }),
      ),
    ).toThrow();
    expect(() =>
      validateOfficialNewsDocument(
        createDocument(MIN_OFFICIAL_ENTRY_COUNT, { 1: { targetUrl: "/\\other.example/news" } }),
      ),
    ).toThrow();
  });

  it("実在する未来日時を許可する", () => {
    expect(() =>
      validateOfficialNewsDocument(
        createDocument(MIN_OFFICIAL_ENTRY_COUNT, {
          1: { newsDate: "2099年08月03日 12時00分00秒" },
        }),
      ),
    ).not.toThrow();
  });

  it("既存IDの変更100件を許可し、101件を拒否する", () => {
    const existing = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const allowed = createDocument(
      MIN_OFFICIAL_ENTRY_COUNT,
      Object.fromEntries(
        Array.from({ length: MAX_UPDATED_EXISTING_ENTRY_COUNT }, (_, index) => [
          index + 1,
          { title: `変更${index}` },
        ]),
      ),
    );
    expect(() =>
      validateOfficialNewsDocument(allowed, { existingDocument: existing }),
    ).not.toThrow();
    const rejected = createDocument(
      MIN_OFFICIAL_ENTRY_COUNT,
      Object.fromEntries(
        Array.from({ length: MAX_UPDATED_EXISTING_ENTRY_COUNT + 1 }, (_, index) => [
          index + 1,
          { title: `変更${index}` },
        ]),
      ),
    );
    expect(() => validateOfficialNewsDocument(rejected, { existingDocument: existing })).toThrow();
  });
});

describe("統合と正規化", () => {
  it("公式データを優先し、既存IDを保持して決定的にソートする", async () => {
    const existing = {
      news: [
        createNews(1, { newsDate: "2026年07月01日 00時00分00秒" }),
        createNews(2, { newsDate: "2026年08月01日 12時00分00秒" }),
      ],
    };
    const official = {
      news: Array.from({ length: MIN_OFFICIAL_ENTRY_COUNT }, (_, index) =>
        createNews(index + 1, {
          title: index === 0 ? "公式の更新" : `公式${index + 1}`,
          newsDate: index < 2 ? "2026年08月01日 12時00分00秒" : "2026年08月01日 11時00分00秒",
        }),
      ),
    };
    const result = await mergeNewsDocuments(existing, official);
    expect(result.document.news[0].id).toBe(2);
    expect(result.document.news[1].id).toBe(1);
    expect(result.document.news.find((news) => news.id === 1)?.title).toBe("公式の更新");
    expect(result.stats.beforeCount).toBe(2);
    expect(result.stats.addedCount).toBe(MIN_OFFICIAL_ENTRY_COUNT - 2);
    expect(result.stats.updatedCount).toBe(2);
    expect(result.document.news).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(JSON.parse(result.json)).toEqual(result.document);
    expect(result).not.toHaveProperty("digest");
  });

  it("検証済みAPI経路ではcanonical JSONとdigestを生成しない", () => {
    const existing = createDocument(1);
    const official = createDocument(MIN_OFFICIAL_ENTRY_COUNT);
    const result = mergeValidatedNewsDocument(existing, official);
    expect(result.document.news).toHaveLength(MIN_OFFICIAL_ENTRY_COUNT);
    expect(result).not.toHaveProperty("normalizedJson");
    expect(result).not.toHaveProperty("digest");
  });

  it("未知フィールドのキー順だけが違う項目を変更扱いにしない", () => {
    const existing = createDocument(MIN_OFFICIAL_ENTRY_COUNT, {
      1: { extra: { a: 1, b: 2 } },
    });
    const official = createDocument(MIN_OFFICIAL_ENTRY_COUNT, {
      1: { extra: { b: 2, a: 1 } },
    });
    const result = mergeValidatedNewsDocument(existing, official, {
      validateOfficialEntries: true,
    });
    expect(result.stats.updatedCount).toBe(0);
    expect(result.document.news[0]).toBe(existing.news[0]);
  });

  it("公式データの日時とURLは新規または変更項目だけ検証する", () => {
    const existing = createDocument(MIN_OFFICIAL_ENTRY_COUNT, {
      1: { newsDate: "保存時に検証済み" },
    });
    const unchanged = structuredClone(existing);
    expect(() =>
      mergeValidatedNewsDocument(existing, unchanged, { validateOfficialEntries: true }),
    ).not.toThrow();

    const changed = structuredClone(unchanged);
    changed.news[0].title = "変更";
    expect(() =>
      mergeValidatedNewsDocument(existing, changed, { validateOfficialEntries: true }),
    ).toThrow();
  });

  it("キー順だけが違う文書は同じ正規化JSONになる", async () => {
    const first = {
      news: [createNews(1, { extra: { z: 1, a: ["x", "y"], "\uffff": 2, 𐀀: 1 } })],
    };
    const second = {
      news: [
        {
          extra: { 𐀀: 1, "\uffff": 2, a: ["x", "y"], z: 1 },
          updated: first.news[0].updated,
          newsDate: first.news[0].newsDate,
          title: first.news[0].title,
          targetUrl: first.news[0].targetUrl,
          id: 1,
        },
      ],
    };
    expect(normalizeNewsDocument(first)).toBe(normalizeNewsDocument(second));
    expect((await canonicalizeNewsDocument(first)).digest).toBe(
      (await canonicalizeNewsDocument(second)).digest,
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("JSONで安全に表現できない値を拒否する", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      validateStoredNewsDocument({ news: [createNews(1, { extra: circular })] }),
    ).toThrow();
    expect(() =>
      validateStoredNewsDocument({ news: [createNews(1, { extra: undefined })] }),
    ).toThrow();
  });
});
