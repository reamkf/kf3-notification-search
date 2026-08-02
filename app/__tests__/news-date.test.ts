import { describe, expect, it } from "vitest";
import { parseJapaneseNewsDate, sortNewsByDate } from "../news-date";

describe("日本語ニュース日時", () => {
  it("JSTの日時を正しく解析する", () => {
    expect(parseJapaneseNewsDate("2026年08月01日 13時00分00秒")).toBe(
      Date.parse("2026-08-01T04:00:00.000Z"),
    );
  });

  it("新しい日時のニュースを先に並べる", () => {
    const news = [
      { title: "古いニュース", newsDate: "2026年08月01日 12時00分00秒" },
      { title: "新しいニュース", newsDate: "2026年08月01日 13時00分00秒" },
    ];

    expect(sortNewsByDate(news).map(({ title }) => title)).toEqual([
      "新しいニュース",
      "古いニュース",
    ]);
  });
});
