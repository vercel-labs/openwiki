import { NextRequest } from "next/server";
import { normalizeGitHubAvatarUrl } from "@/lib/github-repo-url";

type GitHubSearchItem = {
  description?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  owner?: {
    avatar_url?: unknown;
  };
  private?: unknown;
  stargazers_count?: unknown;
};

type SearchResult = {
  description: string | null;
  fullName: string;
  iconSrc: string | null;
  repoUrl: string;
  starCount: number | null;
};

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) {
    return Response.json({ repositories: [] });
  }

  const response = await fetch(
    `https://api.github.com/search/repositories?${new URLSearchParams({
      per_page: "30",
      q: `${query} in:name,full_name fork:false`,
    })}`,
    {
      headers: githubHeaders(),
      next: { revalidate: 60 * 10 },
    },
  );

  if (!response.ok) {
    return Response.json({ error: "Could not search GitHub repositories." }, { status: 502 });
  }

  const body = (await response.json()) as { items?: GitHubSearchItem[] };
  const rankedRepositories = (body.items ?? [])
    .flatMap(toSearchResult)
    .map((repository, index) => ({
      ...repository,
      rank: getSearchResultRank(repository, query, index),
    }));
  rankedRepositories.sort((a, b) => a.rank - b.rank);

  const repositories = rankedRepositories
    .slice(0, 9)
    .map(({ description, fullName, iconSrc, repoUrl, starCount }) => ({
      description,
      fullName,
      iconSrc,
      repoUrl,
      starCount,
    }));

  return Response.json({ repositories });
}

function toSearchResult(item: GitHubSearchItem): SearchResult[] {
  if (
    item.private === true ||
    typeof item.full_name !== "string" ||
    typeof item.html_url !== "string"
  ) {
    return [];
  }

  return [
    {
      description: typeof item.description === "string" && item.description.length > 0 ? item.description : null,
      fullName: item.full_name,
      iconSrc: normalizeGitHubAvatarUrl(item.owner?.avatar_url),
      repoUrl: item.html_url,
      starCount: typeof item.stargazers_count === "number" ? item.stargazers_count : null,
    },
  ];
}

function getSearchResultRank(repository: SearchResult, query: string, index: number): number {
  const normalizedQuery = query.toLowerCase();
  const fullName = repository.fullName.toLowerCase();
  const repoName = fullName.split("/")[1] ?? fullName;

  if (fullName === normalizedQuery) return index;
  if (repoName === normalizedQuery) return 1_000 + index;
  if (fullName.startsWith(normalizedQuery)) return 2_000 + index;
  if (repoName.startsWith(normalizedQuery)) return 3_000 + index;
  return 4_000 + index;
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
