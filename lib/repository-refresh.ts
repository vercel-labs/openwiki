import { featuredRepositories } from "@/app/lib/featured-repositories";
import {
  getGitHubDefaultBranchCommitSha,
  getGitHubRepositoryProfile,
} from "@/lib/github-repository";
import { parseGitHubRepoUrl } from "@/lib/github-repo-url";
import { startRepositoryIndexing } from "@/lib/repository-indexing";
import { wikiGeneratorVersion } from "@/lib/wiki-generator-version";
import {
  listRepositoryRefreshTargets,
  recordRepositoryMetadata,
  recordRepositoryRefreshCheck,
  syncFeaturedRepositories,
  type RepositoryRefreshTarget,
  upsertRepository,
} from "@/lib/storage";

const defaultScanLimit = 100;
const defaultEnqueueLimit = 3;
const defaultGeneratorEnqueueLimit = 12;
const defaultRetryCooldownHours = 24;

export type RefreshOutcome = {
  currentCommitSha: string | null;
  currentGeneratorVersion: string | null;
  fullName: string;
  isFeatured: boolean;
  jobId?: string;
  latestCommitSha?: string;
  latestGeneratorVersion: string;
  message?: string;
  status: "active" | "cooldown" | "current" | "deferred" | "error" | "queued";
  staleReason?: "generator" | "repository";
};

export type RefreshRepositoriesResult = {
  enqueueLimit: number;
  featured: {
    errors: Array<{ fullName: string; message: string }>;
    total: number;
  };
  generatorEnqueueLimit: number;
  outcomes: RefreshOutcome[];
  queued: number;
  queuedGeneratorRefreshes: number;
  retryCooldownHours: number;
  scanned: number;
};

export async function refreshRepositories(input: {
  enqueueLimit?: number;
  generatorEnqueueLimit?: number;
  request?: Request;
  retryCooldownHours?: number;
  scanLimit?: number;
  webUrl?: string;
} = {}): Promise<RefreshRepositoriesResult> {
  const scanLimit = readPositiveInteger(input.scanLimit, process.env.OPENWIKI_REFRESH_SCAN_LIMIT, defaultScanLimit);
  const enqueueLimit = readNonNegativeInteger(
    input.enqueueLimit,
    process.env.OPENWIKI_REFRESH_ENQUEUE_LIMIT,
    defaultEnqueueLimit,
  );
  const generatorEnqueueLimit = readNonNegativeInteger(
    input.generatorEnqueueLimit,
    process.env.OPENWIKI_REFRESH_GENERATOR_ENQUEUE_LIMIT,
    Math.max(enqueueLimit, defaultGeneratorEnqueueLimit),
  );
  const retryCooldownHours = readNonNegativeInteger(
    input.retryCooldownHours,
    process.env.OPENWIKI_REFRESH_RETRY_COOLDOWN_HOURS,
    defaultRetryCooldownHours,
  );
  const retryCooldownMs = retryCooldownHours * 60 * 60 * 1000;

  const featured = await ensureFeaturedRepositories();
  const targets = await listRepositoryRefreshTargets(scanLimit);
  const outcomes: RefreshOutcome[] = [];
  let queued = 0;
  let queuedGeneratorRefreshes = 0;

  for (const target of targets) {
    const featuredBootstrapTarget = isFeaturedBootstrapTarget(target);
    const generatorCatchUpTarget = isFeaturedGeneratorCatchUpTarget(target);
    const outcome = await refreshTarget({
      enqueue:
        queued < enqueueLimit ||
        featuredBootstrapTarget ||
        (generatorCatchUpTarget && queuedGeneratorRefreshes < generatorEnqueueLimit),
      request: input.request,
      retryCooldownMs,
      target,
      webUrl: input.webUrl,
    });
    outcomes.push(outcome);

    if (outcome.status === "queued") {
      queued += 1;
      if (generatorCatchUpTarget) {
        queuedGeneratorRefreshes += 1;
      }
    }
  }

  return {
    enqueueLimit,
    featured,
    generatorEnqueueLimit,
    outcomes,
    queued,
    queuedGeneratorRefreshes,
    retryCooldownHours,
    scanned: targets.length,
  };
}

function isFeaturedBootstrapTarget(target: RepositoryRefreshTarget): boolean {
  return target.isFeatured && target.currentCommitSha === null;
}

function isFeaturedGeneratorCatchUpTarget(target: RepositoryRefreshTarget): boolean {
  return target.isFeatured && target.currentGeneratorVersion !== wikiGeneratorVersion;
}

async function refreshTarget(input: {
  enqueue: boolean;
  request?: Request;
  retryCooldownMs: number;
  target: RepositoryRefreshTarget;
  webUrl?: string;
}): Promise<RefreshOutcome> {
  const { enqueue, request, retryCooldownMs, target, webUrl } = input;

  try {
    const profile = await getGitHubRepositoryProfile(target);
    await recordRepositoryMetadata({
      defaultBranch: profile.defaultBranch,
      description: profile.description,
      ownerAvatarUrl: profile.ownerAvatarUrl,
      repositoryId: target.id,
      stargazersCount: profile.stargazersCount,
    });

    if (!enqueue) {
      await recordRepositoryRefreshCheck({
        enqueued: false,
        repositoryId: target.id,
      });

      return {
        currentCommitSha: target.currentCommitSha,
        currentGeneratorVersion: target.currentGeneratorVersion,
        fullName: target.fullName,
        isFeatured: target.isFeatured,
        latestGeneratorVersion: wikiGeneratorVersion,
        message: "Refresh queue limit reached for this schedule run.",
        status: "deferred",
      };
    }

    const latestCommitSha = await getGitHubDefaultBranchCommitSha(target, profile.defaultBranch);
    const generatorIsCurrent = target.currentGeneratorVersion === wikiGeneratorVersion;
    const repositoryIsCurrent = target.currentCommitSha === latestCommitSha;

    if (repositoryIsCurrent && generatorIsCurrent) {
      await recordRepositoryRefreshCheck({
        enqueued: false,
        latestCommitSha,
        latestGeneratorVersion: wikiGeneratorVersion,
        repositoryId: target.id,
      });

      return {
        currentCommitSha: target.currentCommitSha,
        currentGeneratorVersion: target.currentGeneratorVersion,
        fullName: target.fullName,
        isFeatured: target.isFeatured,
        latestCommitSha,
        latestGeneratorVersion: wikiGeneratorVersion,
        status: "current",
      };
    }

    const staleReason = repositoryIsCurrent ? "generator" : "repository";

    if (isRetryCoolingDown({
      latestCommitSha,
      latestGeneratorVersion: wikiGeneratorVersion,
      retryCooldownMs,
      target,
    })) {
      await recordRepositoryRefreshCheck({
        enqueued: false,
        latestCommitSha,
        latestGeneratorVersion: wikiGeneratorVersion,
        repositoryId: target.id,
      });

      return {
        currentCommitSha: target.currentCommitSha,
        currentGeneratorVersion: target.currentGeneratorVersion,
        fullName: target.fullName,
        isFeatured: target.isFeatured,
        latestCommitSha,
        latestGeneratorVersion: wikiGeneratorVersion,
        message: "This repository state was already queued recently; waiting for retry cooldown.",
        status: "cooldown",
        staleReason,
      };
    }

    await recordRepositoryRefreshCheck({
      enqueued: true,
      latestCommitSha,
      latestGeneratorVersion: wikiGeneratorVersion,
      repositoryId: target.id,
    });

    const start = await startRepositoryIndexing({
      repository: target,
      request,
      webUrl,
    });

    return {
      currentCommitSha: target.currentCommitSha,
      currentGeneratorVersion: target.currentGeneratorVersion,
      fullName: target.fullName,
      isFeatured: target.isFeatured,
      jobId: start.job.id,
      latestCommitSha,
      latestGeneratorVersion: wikiGeneratorVersion,
      status: start.created ? "queued" : "active",
      staleReason,
    };
  } catch (error) {
    const message = getErrorMessage(error, "Refresh failed.");

    console.error("Scheduled repository refresh target failed.", {
      currentCommitSha: target.currentCommitSha,
      fullName: target.fullName,
      message,
      repositoryId: target.id,
      stack: error instanceof Error ? error.stack : undefined,
    });

    await recordRepositoryRefreshCheck({
      enqueued: false,
      repositoryId: target.id,
    });

    return {
      currentCommitSha: target.currentCommitSha,
      currentGeneratorVersion: target.currentGeneratorVersion,
      fullName: target.fullName,
      isFeatured: target.isFeatured,
      latestGeneratorVersion: wikiGeneratorVersion,
      message,
      status: "error",
    };
  }
}

async function ensureFeaturedRepositories(): Promise<{
  errors: Array<{ fullName: string; message: string }>;
  total: number;
}> {
  const errors: Array<{ fullName: string; message: string }> = [];

  for (const featured of featuredRepositories) {
    const ref = parseGitHubRepoUrl(featured.repoUrl);
    if (ref === null) {
      errors.push({
        fullName: featured.fullName,
        message: "Invalid featured repository URL.",
      });
      continue;
    }

    try {
      await upsertRepository(ref);
    } catch (error) {
      errors.push({
        fullName: featured.fullName,
        message: error instanceof Error ? error.message : "Could not upsert featured repository.",
      });
    }
  }

  try {
    await syncFeaturedRepositories(featuredRepositories.map((repository) => repository.fullName));
  } catch (error) {
    errors.push({
      fullName: "featured repositories",
      message: error instanceof Error ? error.message : "Could not sync featured repository markers.",
    });
  }

  return {
    errors,
    total: featuredRepositories.length,
  };
}

function isRetryCoolingDown(input: {
  latestCommitSha: string;
  latestGeneratorVersion: string;
  retryCooldownMs: number;
  target: RepositoryRefreshTarget;
}): boolean {
  const { latestCommitSha, latestGeneratorVersion, retryCooldownMs, target } = input;
  if (retryCooldownMs <= 0) return false;
  if (isFeaturedBootstrapTarget(target)) return false;
  if (target.lastRefreshAttemptedCommitSha !== latestCommitSha) return false;
  if (target.lastRefreshAttemptedGeneratorVersion !== latestGeneratorVersion) return false;
  if (target.lastRefreshEnqueuedAt === null) return false;

  const lastEnqueuedAt = Date.parse(target.lastRefreshEnqueuedAt);
  if (!Number.isFinite(lastEnqueuedAt)) return false;

  return Date.now() - lastEnqueuedAt < retryCooldownMs;
}

function readPositiveInteger(value: number | undefined, fallback: string | undefined, defaultValue: number): number {
  return Math.max(1, readInteger(value, fallback, defaultValue));
}

function readNonNegativeInteger(value: number | undefined, fallback: string | undefined, defaultValue: number): number {
  return Math.max(0, readInteger(value, fallback, defaultValue));
}

function readInteger(value: number | undefined, fallback: string | undefined, defaultValue: number): number {
  if (value !== undefined) {
    return Number.isFinite(value) ? Math.trunc(value) : defaultValue;
  }

  const parsed = Number.parseInt(fallback ?? "", 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
