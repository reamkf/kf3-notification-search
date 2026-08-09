import { z } from "zod";

export const newsSchema = z.object({
  targetUrl: z.string(),
  title: z.string(),
  newsDate: z.string(),
  updated: z.string(),
});

export const newsArraySchema = z.array(newsSchema);

export type News = z.infer<typeof newsSchema>;

export const storedNewsSchema = z.looseObject({
  id: z.number().int().positive(),
  targetUrl: z.string().min(1),
  title: z.string().min(1),
  newsDate: z.string(),
  updated: z.string(),
  category: z.string().optional(),
});

export const storedNewsDocumentSchema = z.looseObject({
  news: z.array(storedNewsSchema),
});

export type StoredNews = z.infer<typeof storedNewsSchema>;
export type StoredNewsDocument = z.infer<typeof storedNewsDocumentSchema>;
