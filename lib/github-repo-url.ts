const GITHUB_REPO_PATTERN = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i;
const SAFE_REPO_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type GitHubRepoRef = {
  owner: string;
  name: string;
  fullName: string;
  url: string;
};

export function parseGitHubRepoUrl(value: string): GitHubRepoRef | null {
  const match = GITHUB_REPO_PATTERN.exec(value.trim());
  if (match === null) return null;

  const owner = match[1];
  const name = match[2].replace(/\.git$/i, "");

  if (!SAFE_REPO_PART_PATTERN.test(owner) || !SAFE_REPO_PART_PATTERN.test(name)) {
    return null;
  }

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  };
}

export function getRepoHref(repo: Pick<GitHubRepoRef, "owner" | "name">): string {
  return `/${repo.owner}/${repo.name}`;
}

export function getGitHubOwnerAvatarFallbackUrl(owner: string): string {
  const normalizedOwner = owner.trim();
  if (normalizedOwner.length === 0) return "https://github.com/favicon.ico";
  return `https://github.com/${encodeURIComponent(normalizedOwner)}.png?size=40`;
}

export function normalizeGitHubAvatarUrl(value: unknown, size = 40): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "avatars.githubusercontent.com") {
      return null;
    }

    url.searchParams.set("s", String(size));
    return url.toString();
  } catch {
    return null;
  }
}
