const databaseUrlMissingMessage = "DATABASE_URL is required for OpenWiki storage.";

export function isStorageConfigurationError(error: unknown): boolean {
  return error instanceof Error && error.message === databaseUrlMissingMessage;
}

export function getStorageConfigurationErrorMessage(): string {
  return "OpenWiki storage is not configured. Set DATABASE_URL in your local environment to generate and read repository wikis.";
}

export function storageConfigurationErrorResponse(error: unknown): Response | null {
  if (!isStorageConfigurationError(error)) return null;

  return Response.json(
    { error: getStorageConfigurationErrorMessage() },
    { status: 503 },
  );
}
