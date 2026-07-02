import { normalizeGitHubAvatarUrl, type GitHubRepoRef } from "@/lib/github-repo-url";

export type GitHubRepositoryMetadata = {
  commitSha: string;
  defaultBranch: string;
  description: string | null;
  ownerAvatarUrl: string | null;
  stargazersCount: number | null;
};

export type GitHubRepositoryProfile = Omit<GitHubRepositoryMetadata, "commitSha">;

export async function getGitHubRepositoryMetadata(
  ref: Pick<GitHubRepoRef, "fullName" | "name" | "owner">,
): Promise<GitHubRepositoryMetadata> {
  const profile = await getGitHubRepositoryProfile(ref);
  const commitSha = await getGitHubDefaultBranchCommitSha(ref, profile.defaultBranch);

  return {
    ...profile,
    commitSha,
  };
}

export async function getGitHubRepositoryProfile(
  ref: Pick<GitHubRepoRef, "name" | "owner">,
): Promise<GitHubRepositoryProfile> {
  const metadata = await fetchGitHubJson<{
    default_branch?: string;
    description?: unknown;
    owner?: {
      avatar_url?: unknown;
    };
    private?: unknown;
    stargazers_count?: unknown;
  }>(
    `https://api.github.com/repos/${ref.owner}/${ref.name}`,
  );
  assertPublicGitHubRepository(metadata);
  const defaultBranch = metadata.default_branch ?? "main";

  return {
    defaultBranch,
    description: typeof metadata.description === "string" && metadata.description.length > 0
      ? metadata.description
      : null,
    ownerAvatarUrl: normalizeGitHubAvatarUrl(metadata.owner?.avatar_url),
    stargazersCount: typeof metadata.stargazers_count === "number"
      ? metadata.stargazers_count
      : null,
  };
}

export async function getGitHubDefaultBranchCommitSha(
  ref: Pick<GitHubRepoRef, "fullName" | "name" | "owner">,
  defaultBranch: string,
): Promise<string> {
  const branch = await fetchGitHubJson<{ commit?: { sha?: string } }>(
    `https://api.github.com/repos/${ref.owner}/${ref.name}/branches/${encodeURIComponent(defaultBranch)}`,
  );
  const commitSha = branch.commit?.sha;

  if (commitSha === undefined) {
    throw new Error(`Could not resolve ${ref.fullName} default branch commit.`);
  }

  return commitSha;
}

export async function githubRepositoryExists(fullName: string): Promise<boolean> {
  const response = await fetch(`https://api.github.com/repos/${fullName}`, {
    headers: githubHeaders(),
  });

  if (response.status === 404) {
    return false;
  }

  if (response.status === 403) {
    return githubRepositoryPageExists(fullName);
  }

  if (!response.ok) {
    throw new Error("Could not verify GitHub repository.");
  }

  const metadata = (await response.json()) as { private?: unknown };
  if (metadata.private === true) {
    return false;
  }

  return true;
}

async function githubRepositoryPageExists(fullName: string): Promise<boolean> {
  const response = await fetch(`https://github.com/${fullName}`, {
    method: "HEAD",
  });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    throw new Error("Could not verify GitHub repository.");
  }

  return true;
}

async function fetchGitHubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubHeaders(),
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error("GitHub request was rate-limited or forbidden. Set GITHUB_TOKEN for reliable refreshes.");
    }

    throw new Error(`GitHub request failed (${response.status}): ${url}`);
  }

  return (await response.json()) as T;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "openwiki",
  };

  const token = process.env.GITHUB_TOKEN?.trim();
  if (token !== undefined && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }

  return headers;
}

function assertPublicGitHubRepository(metadata: { private?: unknown }) {
  if (metadata.private === true) {
    throw new Error("OpenWiki only supports public GitHub repositories.");
  }
}
