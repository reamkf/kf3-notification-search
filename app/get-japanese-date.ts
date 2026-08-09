import dayjs from "dayjs";
import "dayjs/locale/ja";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.locale("ja");
dayjs.extend(utc);
dayjs.extend(timezone);

const japaneseTimeZone = "Asia/Tokyo";

export const getJapaneseDate = (date?: string) => {
  return (date ? dayjs(date) : dayjs()).tz(japaneseTimeZone).format("YYYY-MM-DD");
};
