import * as v from "valibot";
type ValidationInput = Parameters<typeof v.safeParse>[1];

export const NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION = 2;

export type NewsArchiveUpdateMessage = {
  version: typeof NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION;
  reason: "refresh-detected-change" | "refresh-current-missing";
  detectedAt: string;
  addedCount: number;
  updatedCount: number;
  requiresInitialization: boolean;
};

const messageSchema = v.object({
  version: v.literal(NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION),
  reason: v.union([v.literal("refresh-detected-change"), v.literal("refresh-current-missing")]),
  detectedAt: v.pipe(
    v.string(),
    v.check((value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
    }),
  ),
  addedCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  updatedCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  requiresInitialization: v.boolean(),
});

export const isNewsArchiveUpdateMessage = (
  value: ValidationInput,
): value is NewsArchiveUpdateMessage => {
  const result = v.safeParse(messageSchema, value);
  if (!result.success) return false;
  const message = result.output;
  const hasChanges = message.addedCount + message.updatedCount > 0;
  return (
    (message.reason === "refresh-detected-change" &&
      hasChanges &&
      !message.requiresInitialization) ||
    (message.reason === "refresh-current-missing" && message.requiresInitialization)
  );
};
