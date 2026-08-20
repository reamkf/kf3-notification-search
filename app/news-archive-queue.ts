export const NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION = 1;

export type NewsArchiveUpdateMessage = {
  version: typeof NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION;
  reason: "refresh-detected-change";
  detectedAt: string;
  addedCount: number;
  updatedCount: number;
};

export const isNewsArchiveUpdateMessage = (value: unknown): value is NewsArchiveUpdateMessage => {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  const detectedAt = typeof message.detectedAt === "string" ? Date.parse(message.detectedAt) : NaN;
  return (
    message.version === NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION &&
    message.reason === "refresh-detected-change" &&
    Number.isFinite(detectedAt) &&
    new Date(detectedAt).toISOString() === message.detectedAt &&
    Number.isSafeInteger(message.addedCount) &&
    Number(message.addedCount) >= 0 &&
    Number.isSafeInteger(message.updatedCount) &&
    Number(message.updatedCount) >= 0 &&
    Number(message.addedCount) + Number(message.updatedCount) > 0
  );
};
