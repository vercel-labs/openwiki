import "server-only";

import {
  featuredRepositories,
  getStaticFeaturedRepositoryCards,
  type FeaturedRepositoryCard,
} from "@/app/lib/featured-repositories";
import { isStorageConfigurationError } from "@/app/lib/storage-error";
import { getGitHubRepositoryProfile } from "@/lib/github-repository";
import { getGitHubOwnerAvatarFallbackUrl } from "@/lib/github-repo-url";
import {
  listRepositoryMetadataByFullName,
  recordRepositoryMetadata,
  syncFeaturedRepositories,
  upsertRepository,
  type Repository,
  type RepositoryMetadata,
} from "@/lib/storage";

type FeaturedRepositoryCardOptions = {
  fallbackOnStorageConfigurationError?: boolean;
};

const featuredMetadataMaxAgeMs = 6 * 60 * 60 * 1000;
const featuredMetadataRefreshConcurrency = 6;

export type FeaturedRepositoryMetadataRefreshResult = {
  errors: Array<{ fullName: string; message: string }>;
  refreshed: number;
  stale: number;
};

export async function getFeaturedRepositoryCards(
  options: FeaturedRepositoryCardOptions = {},
): Promise<FeaturedRepositoryCard[]> {
  try {
    const storedRepositories = await listRepositoryMetadataByFullName(
      featuredRepositories.map((repository) => repository.fullName),
    );
    const storedByFullName = new Map(
      storedRepositories.map((repository) => [repository.fullName, repository]),
    );

    return featuredRepositories.map((repository) => {
      const stored = storedByFullName.get(repository.fullName);
      const stargazersCount = stored?.stargazersCount ?? null;

      return {
        description: stored?.description ?? repository.description,
        fullName: repository.fullName,
        iconSrc: stored?.ownerAvatarUrl ?? getGitHubOwnerAvatarFallbackUrl(repository.fullName.split("/")[0] ?? ""),
        repoUrl: stored?.githubUrl ?? repository.repoUrl,
        starCount: stargazersCount,
        starLabel: stargazersCount === null ? repository.starLabel : undefined,
      };
    });
  } catch (error) {
    if (options.fallbackOnStorageConfigurationError && isStorageConfigurationError(error)) {
      return getStaticFeaturedRepositoryCards();
    }

    throw error;
  }
}

export async function refreshFeaturedRepositoryMetadata(): Promise<FeaturedRepositoryMetadataRefreshResult> {
  const repositories = await ensureFeaturedRepositoryRecords();
  const storedRepositories = await listRepositoryMetadataByFullName(
    featuredRepositories.map((repository) => repository.fullName),
  );
  const storedByFullName = new Map(
    storedRepositories.map((repository) => [repository.fullName, repository]),
  );
  const staleRepositories = repositories.filter((repository) =>
    isFeaturedMetadataStale(storedByFullName.get(repository.fullName))
  );

  const errors: FeaturedRepositoryMetadataRefreshResult["errors"] = [];
  let refreshed = 0;

  await runWithConcurrency(staleRepositories, featuredMetadataRefreshConcurrency, async (repository) => {
    try {
      const profile = await getGitHubRepositoryProfile(repository);
      await recordRepositoryMetadata({
        defaultBranch: profile.defaultBranch,
        description: profile.description,
        ownerAvatarUrl: profile.ownerAvatarUrl,
        repositoryId: repository.id,
        stargazersCount: profile.stargazersCount,
      });
      refreshed += 1;
    } catch (error) {
      errors.push({
        fullName: repository.fullName,
        message: error instanceof Error ? error.message : "Could not refresh repository metadata.",
      });
    }
  });

  return {
    errors,
    refreshed,
    stale: staleRepositories.length,
  };
}

async function ensureFeaturedRepositoryRecords(): Promise<Repository[]> {
  const repositories: Repository[] = [];

  for (const featured of featuredRepositories) {
    const [owner, name] = featured.fullName.split("/");
    if (!owner || !name) continue;

    repositories.push(
      await upsertRepository({
        fullName: featured.fullName,
        name,
        owner,
        url: featured.repoUrl,
      }),
    );
  }

  await syncFeaturedRepositories(featuredRepositories.map((repository) => repository.fullName));

  return repositories;
}

function isFeaturedMetadataStale(metadata: RepositoryMetadata | undefined): boolean {
  if (metadata === undefined) return true;
  if (metadata.stargazersCount === null) return true;
  if (metadata.lastMetadataRefreshedAt === null) return true;

  const lastRefreshedAt = Date.parse(metadata.lastMetadataRefreshedAt);
  if (!Number.isFinite(lastRefreshedAt)) return true;

  return Date.now() - lastRefreshedAt > featuredMetadataMaxAgeMs;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;

        if (item !== undefined) {
          await run(item);
        }
      }
    }),
  );
}
