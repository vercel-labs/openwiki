const INTERNAL_DOCS_DIRECTORY_PATTERN =
  /^(?:docs|documentation)\/(?:active|completed|drafts?|notes?|plans?|planning|research|scratch|scratchpad|tmp|todo)\//i;

const INTERNAL_DOCS_FILE_PATTERN =
  /(?:^|\/).*(?:feedback|deep-dive|harness-gaps?|gap-analysis|quality-runs?|research-plan|implementation-plan|workflow-plan|auto-update-plan|porting-notes?|scratchpad|todo).*\.(?:md|mdx|mdoc|txt)$/i;

export function isInternalPlanningDocumentationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();

  if (/^(?:docs|documentation)\/readme\.(?:md|mdx|mdoc|txt)$/i.test(normalized)) {
    return true;
  }

  if (INTERNAL_DOCS_DIRECTORY_PATTERN.test(normalized)) return true;

  return (
    normalized.startsWith("docs/") ||
    normalized.startsWith("documentation/")
  ) && INTERNAL_DOCS_FILE_PATTERN.test(normalized);
}
