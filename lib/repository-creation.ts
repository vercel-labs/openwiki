export const repositoryCreationDisabledCode = "repository_creation_disabled";
export const repositoryCreationDisabledMessage =
  "Repository creation is disabled for this OpenWiki deployment.";

export function isRepositoryCreationDisabled(): boolean {
  const value = process.env.OPENWIKI_DISABLE_REPOSITORY_CREATION;
  if (value === undefined || value.trim().length === 0) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
