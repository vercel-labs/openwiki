import { featuredRepositories } from "@/app/lib/featured-repositories";
import { parseGitHubRepoUrl } from "@/lib/github-repo-url";
import { listPublishedWikiRouteParams } from "@/lib/storage";

export type WikiRootStaticParam = {
  owner: string;
  repo: string;
};

export type WikiSlugStaticParam = WikiRootStaticParam & {
  slug: string;
};

export function getFeaturedWikiStaticParams(): WikiRootStaticParam[] {
  return getFeaturedRepositories().map((repo) => ({
    owner: repo.owner,
    repo: repo.name,
  }));
}

export async function getFeaturedWikiSlugStaticParams(): Promise<WikiSlugStaticParam[]> {
  const repositories = getFeaturedRepositories();

  try {
    return await listPublishedWikiRouteParams(repositories);
  } catch (error) {
    console.warn(
      "Could not load published wiki page slugs for static generation.",
      error,
    );
    return [];
  }
}

function getFeaturedRepositories() {
  const seen = new Set<string>();
  return featuredRepositories.flatMap((featured) => {
    const repo = parseGitHubRepoUrl(featured.repoUrl);
    if (repo === null || seen.has(repo.fullName)) return [];
    seen.add(repo.fullName);
    return [repo];
  });
}
