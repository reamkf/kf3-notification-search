export const NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION = 2;

export type NewsArchiveUpdateMessage = {
  version: typeof NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION;
  reason: "refresh-detected-change" | "refresh-current-missing";
  detectedAt: string;
  addedCount: number;
  updatedCount: number;
  requiresInitialization: boolean;
};

export const isNewsArchiveUpdateMessage = (value: unknown): value is NewsArchiveUpdateMessage => {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  const detectedAt = typeof message.detectedAt === "string" ? Date.parse(message.detectedAt) : NaN;
  const addedCount = Number(message.addedCount);
  const updatedCount = Number(message.updatedCount);
  const hasChanges = addedCount + updatedCount > 0;
  const requiresInitialization = message.requiresInitialization === true;
  return (
    message.version === NEWS_ARCHIVE_UPDATE_MESSAGE_VERSION &&
    Number.isFinite(detectedAt) &&
    new Date(detectedAt).toISOString() === message.detectedAt &&
    Number.isSafeInteger(message.addedCount) &&
    addedCount >= 0 &&
    Number.isSafeInteger(message.updatedCount) &&
    updatedCount >= 0 &&
    typeof message.requiresInitialization === "boolean" &&
    ((message.reason === "refresh-detected-change" && hasChanges && !requiresInitialization) ||
      (message.reason === "refresh-current-missing" && requiresInitialization))
  );
};
