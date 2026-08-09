import * as v from "valibot";

export const newsSchema = v.object({
  targetUrl: v.string(),
  title: v.string(),
  newsDate: v.string(),
  updated: v.string(),
});

export const newsArraySchema = v.array(newsSchema);

export type News = v.InferOutput<typeof newsSchema>;

export const storedNewsSchema = v.looseObject({
  id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  targetUrl: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  newsDate: v.string(),
  updated: v.string(),
  category: v.optional(v.string()),
});

export const storedNewsDocumentSchema = v.looseObject({
  news: v.array(storedNewsSchema),
});

export type StoredNews = v.InferOutput<typeof storedNewsSchema>;
export type StoredNewsDocument = v.InferOutput<typeof storedNewsDocumentSchema>;

export type ValidationIssueSummary = {
  message: string;
  path: Array<string | number>;
};

export const summarizeValidationIssues = (
  issues: readonly v.BaseIssue<unknown>[],
): ValidationIssueSummary[] =>
  issues.map((issue) => ({
    message: issue.message,
    path:
      issue.path
        ?.map(({ key }) => key)
        .filter(
          (key): key is string | number => typeof key === "string" || typeof key === "number",
        ) ?? [],
  }));
