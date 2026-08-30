import * as v from "valibot";
import { bridgeRuntimeValue } from "./runtime-value";
import {
  newsArraySchema,
  storedNewsDocumentSchema,
  summarizeValidationIssues,
  type JsonInput,
  type JsonObject,
  type JsonValue,
  type News,
  type StoredNews,
  type StoredNewsDocument,
} from "./schema";

type SerializableValue = JsonInput | StoredNews | StoredNewsDocument;

export const MAX_OFFICIAL_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MIN_OFFICIAL_ENTRY_COUNT = 1900;
export const MAX_UPDATED_EXISTING_ENTRY_COUNT = 100;
export const OFFICIAL_NEWS_ORIGIN = "https://kemono-friends-3.jp";

export class NewsDataError extends Error {
  readonly stage: string;
  readonly details: JsonObject;

  constructor(stage: string, message: string, details: JsonObject = {}) {
    super(message);
    this.name = "NewsDataError";
    this.stage = stage;
    this.details = details;
  }
}

const isPlainObject = (value: JsonObject) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

type InputObject = { [key: string]: JsonInput };
type NewsRecord = InputObject & {
  id: number;
  targetUrl: string;
  title: string;
  newsDate: string;
  updated: string;
  category?: string;
};

const isInputObject = (value: SerializableValue): value is InputObject =>
  value !== null &&
  !Array.isArray(value) &&
  Object.prototype.toString.call(value) === "[object Object]";

const isInputString = (value: JsonInput): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

const isInputNumber = (value: JsonInput): value is number =>
  Object.prototype.toString.call(value) === "[object Number]" && Number.isFinite(Number(value));

const isNewsRecord = (value: JsonInput): value is NewsRecord => {
  if (!isInputObject(value)) return false;
  return (
    isInputNumber(value.id) &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    isInputString(value.targetUrl) &&
    value.targetUrl.length > 0 &&
    isInputString(value.title) &&
    value.title.length > 0 &&
    isInputString(value.newsDate) &&
    isInputString(value.updated) &&
    (value.category === undefined || isInputString(value.category))
  );
};

const jsonRecordSchema = v.record(v.string(), v.any());
const jsonPrimitiveSchema = v.union([
  v.null(),
  v.boolean(),
  v.pipe(
    v.number(),
    v.check((value: number) => Number.isFinite(value)),
  ),
  v.string(),
]);

const compareUnicodeCodePoints = (left: string, right: string) => {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex) ?? 0;
    const rightCodePoint = right.codePointAt(rightIndex) ?? 0;
    const difference = leftCodePoint - rightCodePoint;
    if (difference !== 0) return difference;
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }

  return left.length - right.length;
};

const getSortedKeys = (keys: string[], keyOrderCache: Map<string, string[]>) => {
  const signature = keys.map((key) => `${key.length}:${key}`).join("");
  const cached = keyOrderCache.get(signature);
  if (cached) return cached;
  const sorted = keys.sort(compareUnicodeCodePoints);
  keyOrderCache.set(signature, sorted);
  return sorted;
};

const normalizeJsonValue = (
  value: SerializableValue,
  ancestors: Set<SerializableValue>,
  keyOrderCache: Map<string, string[]>,
): JsonValue => {
  const primitive = v.safeParse(jsonPrimitiveSchema, value);
  if (primitive.success) return primitive.output;
  if (value === undefined) {
    throw new NewsDataError("serialization", "JSONで表現できない値が含まれています");
  }

  if (ancestors.has(value)) {
    throw new NewsDataError("serialization", "循環参照を含むデータは保存できません");
  }
  ancestors.add(value);

  let normalized: JsonValue;
  if (Array.isArray(value)) {
    normalized = value.map((item) => normalizeJsonValue(item, ancestors, keyOrderCache));
  } else {
    const objectResult = v.safeParse(jsonRecordSchema, value);
    if (!objectResult.success || !isPlainObject(objectResult.output)) {
      throw new NewsDataError("serialization", "プレーンオブジェクト以外の値は保存できません");
    }

    const propertyNames = Object.getOwnPropertyNames(objectResult.output);
    const enumerableNames = Object.keys(objectResult.output);
    if (
      propertyNames.length !== enumerableNames.length ||
      Object.getOwnPropertySymbols(objectResult.output).length > 0
    ) {
      throw new NewsDataError("serialization", "列挙できないプロパティは保存できません");
    }

    const normalizedObject: JsonObject = {};
    for (const key of getSortedKeys(enumerableNames, keyOrderCache)) {
      normalizedObject[key] = normalizeJsonValue(
        objectResult.output[key],
        ancestors,
        keyOrderCache,
      );
    }
    normalized = normalizedObject;
  }

  ancestors.delete(value);
  return normalized;
};

const stableStringify = (value: SerializableValue) => {
  const normalized = normalizeJsonValue(
    value,
    new Set<SerializableValue>(),
    new Map<string, string[]>(),
  );
  const json = JSON.stringify(normalized);
  if (json === undefined) {
    throw new NewsDataError("serialization", "JSONシリアライズに失敗しました");
  }
  return json;
};

const jsonValuesEqual = (left: SerializableValue, right: SerializableValue): boolean => {
  if (left === right) return true;

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (Array.isArray(right)) return false;

  const leftObject = v.safeParse(jsonRecordSchema, left);
  const rightObject = v.safeParse(jsonRecordSchema, right);
  if (!leftObject.success || !rightObject.success) return false;

  const leftKeys = Object.keys(leftObject.output);
  const rightKeys = Object.keys(rightObject.output);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (
      !Object.hasOwn(rightObject.output, key) ||
      !jsonValuesEqual(leftObject.output[key], rightObject.output[key])
    ) {
      return false;
    }
  }
  return true;
};

const parseDocument = (
  value: SerializableValue,
  stage = "document-validation",
): StoredNewsDocument => {
  const result = v.safeParse(storedNewsDocumentSchema, value);
  if (!result.success) {
    throw new NewsDataError(stage, "保存用お知らせデータの形式が無効です", {
      issues: summarizeValidationIssues(result.issues),
    });
  }
  return result.output;
};

const thresholdError = (
  stage: string,
  thresholdName: string,
  configuredValue: number,
  actualValue: number,
  message: string,
) =>
  new NewsDataError(stage, message, {
    thresholdName,
    configuredValue,
    actualValue,
  });

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

export const parseJapaneseNewsDate = (value: string): number => {
  const match = /^(\d{4})年(\d{2})月(\d{2})日 (\d{2})時(\d{2})分(\d{2})秒$/.exec(value);
  if (!match) {
    throw new NewsDataError("date-validation", "お知らせ日時の形式が無効です");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month === 2 && isLeapYear(year) ? 29 : DAYS_PER_MONTH[month - 1];

  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new NewsDataError("date-validation", "存在しない日時です");
  }

  if (year >= 100) {
    return Date.UTC(year, month - 1, day, hour, minute, second) - JST_OFFSET_MS;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour - 9, minute, second, 0);
  return date.getTime();
};

export const parseNewsDate = parseJapaneseNewsDate;

const newsDateTimestamps = new WeakMap<StoredNews, { value: string; timestamp: number }>();

const getNewsTimestamp = (news: StoredNews) => {
  const cached = newsDateTimestamps.get(news);
  if (cached?.value === news.newsDate) return cached.timestamp;
  const timestamp = parseJapaneseNewsDate(news.newsDate);
  newsDateTimestamps.set(news, { value: news.newsDate, timestamp });
  return timestamp;
};

const validateUniqueIdsAndDates = (document: StoredNewsDocument) => {
  const ids = new Set<number>();
  for (const news of document.news) {
    if (ids.has(news.id)) {
      throw new NewsDataError("document-validation", "お知らせIDが重複しています", {
        id: news.id,
      });
    }
    ids.add(news.id);
    getNewsTimestamp(news);
  }
};

export const normalizeNewsDocument = (value: SerializableValue): string => {
  const document = parseDocument(value);
  return stableStringify(document);
};

const validateAndNormalizeStoredNewsDocument = (value: SerializableValue) => {
  const document = parseDocument(value);
  validateUniqueIdsAndDates(document);
  return { document, normalizedJson: stableStringify(document) };
};

const validateParsedStoredNewsDocumentInternal = (
  value: SerializableValue,
  validateDates: boolean,
): StoredNewsDocument => {
  if (!isInputObject(value) || !Array.isArray(value.news)) {
    throw new NewsDataError("document-validation", "保存用お知らせデータの形式が無効です");
  }

  const ids = new Set<number>();
  for (const [index, item] of value.news.entries()) {
    if (!isNewsRecord(item)) {
      throw new NewsDataError("document-validation", "保存用お知らせデータの形式が無効です", {
        index,
      });
    }
    if (ids.has(item.id)) {
      throw new NewsDataError("document-validation", "お知らせIDが重複しています", {
        id: item.id,
      });
    }
    ids.add(item.id);
    if (validateDates) getNewsTimestamp(item);
  }
  return bridgeRuntimeValue<StoredNewsDocument>(value);
};

export const validateParsedStoredNewsDocument = (value: SerializableValue): StoredNewsDocument =>
  validateParsedStoredNewsDocumentInternal(value, true);

export const validateParsedStoredNewsDocumentStructure = (
  value: SerializableValue,
): StoredNewsDocument => validateParsedStoredNewsDocumentInternal(value, false);

export const validateStoredNewsDocument = (value: SerializableValue): StoredNewsDocument => {
  return validateAndNormalizeStoredNewsDocument(value).document;
};

export const parseStoredNewsDocument = validateStoredNewsDocument;

export const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export type CanonicalNewsDocument = {
  document: StoredNewsDocument;
  normalizedJson: string;
  digest: string;
};

export const canonicalizeNewsDocument = async (
  value: SerializableValue,
): Promise<CanonicalNewsDocument> => {
  const { document, normalizedJson } = validateAndNormalizeStoredNewsDocument(value);
  return {
    document,
    normalizedJson,
    digest: await sha256Hex(normalizedJson),
  };
};

const validateOfficialOrigin = (officialOrigin: string) => {
  let resolvedOrigin: string;
  try {
    resolvedOrigin = new URL("/", officialOrigin).origin;
  } catch {
    throw new NewsDataError("official-validation", "公式お知らせのoriginが無効です");
  }

  if (resolvedOrigin !== officialOrigin) {
    throw new NewsDataError("official-validation", "公式お知らせのoriginが無効です");
  }
  return resolvedOrigin;
};

const validateOfficialEntry = (news: StoredNews) => {
  if (!news.targetUrl.startsWith("/")) {
    throw new NewsDataError(
      "official-validation",
      "公式お知らせURLは相対パスである必要があります",
      {
        id: news.id,
      },
    );
  }
  if (news.targetUrl.startsWith("//") || news.targetUrl.startsWith("/\\")) {
    throw new NewsDataError("official-validation", "公式お知らせURLのoriginが不正です", {
      id: news.id,
    });
  }

  getNewsTimestamp(news);
};

const countUpdatedExistingEntries = (
  existing: StoredNewsDocument,
  official: StoredNewsDocument,
) => {
  const existingById = new Map(existing.news.map((news) => [news.id, news]));
  return official.news.reduce((count, news) => {
    const existingNews = existingById.get(news.id);
    return existingNews !== undefined && !jsonValuesEqual(existingNews, news) ? count + 1 : count;
  }, 0);
};

export type OfficialValidationOptions = {
  existingDocument?: StoredNewsDocument;
  officialOrigin?: string;
};

const validateOfficialDocumentConstraints = (
  document: StoredNewsDocument,
  { officialOrigin = OFFICIAL_NEWS_ORIGIN }: OfficialValidationOptions,
) => {
  if (document.news.length < MIN_OFFICIAL_ENTRY_COUNT) {
    throw thresholdError(
      "threshold-validation",
      "MIN_OFFICIAL_ENTRY_COUNT",
      MIN_OFFICIAL_ENTRY_COUNT,
      document.news.length,
      "公式お知らせ件数が閾値未満です",
    );
  }

  validateOfficialOrigin(officialOrigin);
  for (const news of document.news) {
    validateOfficialEntry(news);
  }
};

export const validateParsedOfficialNewsDocumentStructure = (
  value: SerializableValue,
): StoredNewsDocument => {
  const document = validateParsedStoredNewsDocumentStructure(value);
  if (document.news.length < MIN_OFFICIAL_ENTRY_COUNT) {
    throw thresholdError(
      "threshold-validation",
      "MIN_OFFICIAL_ENTRY_COUNT",
      MIN_OFFICIAL_ENTRY_COUNT,
      document.news.length,
      "公式お知らせ件数が閾値未満です",
    );
  }
  return document;
};

export const validateOfficialNewsDocument = (
  value: SerializableValue,
  options: OfficialValidationOptions = {},
): StoredNewsDocument => {
  const document = validateStoredNewsDocument(value);
  validateOfficialDocumentConstraints(document, options);

  if (options.existingDocument) {
    const updatedCount = countUpdatedExistingEntries(
      validateStoredNewsDocument(options.existingDocument),
      document,
    );
    if (updatedCount > MAX_UPDATED_EXISTING_ENTRY_COUNT) {
      throw thresholdError(
        "threshold-validation",
        "MAX_UPDATED_EXISTING_ENTRY_COUNT",
        MAX_UPDATED_EXISTING_ENTRY_COUNT,
        updatedCount,
        "既存お知らせの変更件数が閾値を超えています",
      );
    }
  }

  return document;
};

export const validateParsedOfficialNewsDocument = (
  value: SerializableValue,
  options: OfficialValidationOptions = {},
): StoredNewsDocument => {
  const document = validateParsedStoredNewsDocument(value);
  validateOfficialDocumentConstraints(document, options);

  if (options.existingDocument) {
    const updatedCount = countUpdatedExistingEntries(
      validateParsedStoredNewsDocument(options.existingDocument),
      document,
    );
    if (updatedCount > MAX_UPDATED_EXISTING_ENTRY_COUNT) {
      throw thresholdError(
        "threshold-validation",
        "MAX_UPDATED_EXISTING_ENTRY_COUNT",
        MAX_UPDATED_EXISTING_ENTRY_COUNT,
        updatedCount,
        "既存お知らせの変更件数が閾値を超えています",
      );
    }
  }

  return document;
};

export const validateOfficialDocument = validateOfficialNewsDocument;

export type NewsMergeStats = {
  beforeCount: number;
  officialCount: number;
  addedCount: number;
  updatedCount: number;
  mergedCount: number;
};

export type NewsMergeOptions = {
  officialOrigin?: string;
  validateOfficialEntries?: boolean;
};

export type ValidatedNewsMergeResult = {
  document: StoredNewsDocument;
  stats: NewsMergeStats;
};

export type NewsMergeResult = ValidatedNewsMergeResult & {
  json: string;
};

const sortNewsByDate = (news: StoredNewsDocument["news"]) =>
  [...news].sort((left, right) => {
    if (left.newsDate < right.newsDate) return 1;
    if (left.newsDate > right.newsDate) return -1;
    return right.id - left.id;
  });

export const serializeSortedNewsDocument = (document: StoredNewsDocument) => {
  const sortedDocument = { ...document, news: sortNewsByDate(document.news) };
  return { document: sortedDocument, json: JSON.stringify(sortedDocument) };
};

const mergeValidatedDocument = (
  existing: StoredNewsDocument,
  official: StoredNewsDocument,
  options?: NewsMergeOptions,
): ValidatedNewsMergeResult => {
  const existingById = new Map(existing.news.map((news) => [news.id, news]));
  let addedCount = 0;
  let updatedCount = 0;

  const officialOrigin = options?.officialOrigin ?? OFFICIAL_NEWS_ORIGIN;
  const validateOfficialEntries = options?.validateOfficialEntries === true;
  if (validateOfficialEntries) {
    validateOfficialOrigin(officialOrigin);
    if (official.news.length < MIN_OFFICIAL_ENTRY_COUNT) {
      throw thresholdError(
        "threshold-validation",
        "MIN_OFFICIAL_ENTRY_COUNT",
        MIN_OFFICIAL_ENTRY_COUNT,
        official.news.length,
        "公式お知らせ件数が閾値未満です",
      );
    }
  }

  for (const news of official.news) {
    const existingNews = existingById.get(news.id);
    if (existingNews === undefined) {
      if (validateOfficialEntries) validateOfficialEntry(news);
      addedCount += 1;
      existingById.set(news.id, news);
    } else if (!jsonValuesEqual(existingNews, news)) {
      if (validateOfficialEntries) validateOfficialEntry(news);
      updatedCount += 1;
      if (updatedCount > MAX_UPDATED_EXISTING_ENTRY_COUNT) {
        throw thresholdError(
          "threshold-validation",
          "MAX_UPDATED_EXISTING_ENTRY_COUNT",
          MAX_UPDATED_EXISTING_ENTRY_COUNT,
          updatedCount,
          "既存お知らせの変更件数が閾値を超えています",
        );
      }
      existingById.set(news.id, news);
    }
  }

  const mergedNews = Array.from(existingById.values());
  const mergedDocument = { ...existing, news: mergedNews };

  return {
    document: mergedDocument,
    stats: {
      beforeCount: existing.news.length,
      officialCount: official.news.length,
      addedCount,
      updatedCount,
      mergedCount: mergedNews.length,
    },
  };
};

export const mergeValidatedNewsDocument = (
  existing: StoredNewsDocument,
  official: StoredNewsDocument,
  options?: NewsMergeOptions,
) => mergeValidatedDocument(existing, official, options);

export const mergeValidatedNewsDocuments = (
  existing: StoredNewsDocument,
  official: StoredNewsDocument,
): NewsMergeResult => {
  const merged = mergeValidatedDocument(existing, official);
  const serialized = serializeSortedNewsDocument(merged.document);
  return {
    document: serialized.document,
    stats: merged.stats,
    json: serialized.json,
  };
};

export const mergeNewsDocuments = async (
  existingValue: SerializableValue,
  officialValue: SerializableValue,
  options: NewsMergeOptions = {},
): Promise<NewsMergeResult> => {
  const existing = validateStoredNewsDocument(existingValue);
  const official = validateStoredNewsDocument(officialValue);
  validateOfficialDocumentConstraints(official, options);
  return mergeValidatedNewsDocuments(existing, official);
};

export const mergeNewsData = mergeNewsDocuments;

export const projectClientNews = (document: StoredNewsDocument): News[] => {
  const parsedDocument = validateStoredNewsDocument(document);
  return v.parse(newsArraySchema, parsedDocument.news);
};

export const projectValidatedClientNews = (document: StoredNewsDocument): News[] =>
  document.news.map(({ targetUrl, title, newsDate, updated, category }) => {
    const clientNews: News = { targetUrl, title, newsDate, updated };
    if (category !== undefined) clientNews.category = category;
    return clientNews;
  });

export const toClientNews = projectClientNews;
