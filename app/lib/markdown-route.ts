export type MarkdownRoute = {
  owner: string;
  repo: string;
  slug?: string;
};

export function parseMarkdownRoute(pathname: string): MarkdownRoute | null {
  if (!pathname.endsWith(".md")) return null;

  const segments = pathname.split("/").filter(Boolean).map(decodePathSegment);
  if (segments.length === 2) {
    const [owner, repoWithExtension] = segments;
    const repo = stripMarkdownExtension(repoWithExtension);
    if (!owner || repo.length === 0) return null;
    return { owner, repo };
  }

  if (segments.length === 3) {
    const [owner, repo, slugWithExtension] = segments;
    const slug = stripMarkdownExtension(slugWithExtension);
    if (!owner || !repo || slug.length === 0) return null;
    return { owner, repo, slug };
  }

  return null;
}

function stripMarkdownExtension(value: string): string {
  return value.slice(0, -".md".length);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
