const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const parseJapaneseNewsDate = (value: string): number => {
  const match = /^(\d{4})年(\d{2})月(\d{2})日 (\d{2})時(\d{2})分(\d{2})秒$/.exec(value);
  if (!match) {
    throw new Error("ニュース日時の形式が無効です");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const jstDate = new Date(0);
  jstDate.setUTCFullYear(year, month - 1, day);
  jstDate.setUTCHours(hour, minute, second, 0);

  const timestamp = jstDate.getTime() - JST_OFFSET_MS;
  const roundTrip = new Date(timestamp + JST_OFFSET_MS);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute ||
    roundTrip.getUTCSeconds() !== second
  ) {
    throw new Error("存在しない日時です");
  }

  return timestamp;
};

export const sortNewsByDate = <T extends { newsDate: string }>(news: readonly T[]): T[] => {
  return news
    .map((item) => ({ item, time: parseJapaneseNewsDate(item.newsDate) }))
    .sort((left, right) => right.time - left.time)
    .map(({ item }) => item);
};
