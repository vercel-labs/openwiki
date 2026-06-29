import { NextRequest } from "next/server";
import { isFeaturedRepositoryFullName } from "@/app/lib/featured-repositories";
import { parseGitHubRepoUrl } from "@/lib/github-repo-url";
import {
  getRepositoryByFullName,
  listRepositories,
  upsertRepository,
} from "@/lib/storage";
import { z } from "zod";
import { storageConfigurationErrorResponse } from "@/app/lib/storage-error";
import { githubRepositoryExists } from "@/lib/github-repository";
import {
  enforceRepositoryGenerationRateLimit,
  RepositoryGenerationRateLimitError,
  repositoryGenerationRateLimitedCode,
} from "@/lib/repository-generation-rate-limit";
import { startRepositoryIndexing } from "./indexing";

const createRepositorySchema = z.object({
  force: z.boolean().optional().default(false),
  repoUrl: z.url({ error: "Expected a public GitHub repository URL." }),
});

export async function GET() {
  try {
    const repositories = await listRepositories();
    return Response.json({ repositories });
  } catch (error) {
    const response = storageConfigurationErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON request body." }, { status: 400 });
  }

  const parsed = createRepositorySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." }, { status: 400 });
  }

  const ref = parseGitHubRepoUrl(parsed.data.repoUrl);
  if (ref === null) {
    return Response.json({ error: "Expected a public GitHub repository URL." }, { status: 400 });
  }
  const isConfiguredFeaturedRepository = isFeaturedRepositoryFullName(ref.fullName);

  let repository;
  try {
    repository = await getRepositoryByFullName(ref.owner, ref.name);
  } catch (error) {
    const response = storageConfigurationErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }

  if (repository === null) {
    let repoExists: boolean;
    try {
      repoExists = await githubRepositoryExists(ref.fullName);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Could not verify GitHub repository." },
        { status: 502 },
      );
    }

    if (!repoExists) {
      return Response.json({ error: "GitHub repository not found." }, { status: 404 });
    }

    try {
      repository = await upsertRepository(ref);
    } catch (error) {
      const response = storageConfigurationErrorResponse(error);
      if (response !== null) return response;
      throw error;
    }
  }

  if (repository.currentIndexedRevisionId !== null && !parsed.data.force) {
    return Response.json(
      {
        job: null,
        repository,
      },
      { status: 200 },
    );
  }

  try {
    const start = await startRepositoryIndexing({
      beforeCreateJob: isConfiguredFeaturedRepository
        ? undefined
        : () =>
            enforceRepositoryGenerationRateLimit({
              repoFullName: repository.fullName,
              request,
            }),
      repository,
      request,
    });

    return Response.json(
      {
        job: start.job,
        repository,
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof RepositoryGenerationRateLimitError) {
      return repositoryGenerationRateLimitedResponse(error);
    }

    const response = storageConfigurationErrorResponse(error);
    if (response !== null) return response;

    return Response.json(
      { error: error instanceof Error ? error.message : "Could not index repository." },
      { status: 502 },
    );
  }
}

function repositoryGenerationRateLimitedResponse(error: RepositoryGenerationRateLimitError) {
  return Response.json(
    {
      code: repositoryGenerationRateLimitedCode,
      error: error.message,
      limit: error.limit,
      resetAt: error.resetAt,
      retryAfter: error.retryAfterSeconds,
      scope: error.scope,
    },
    {
      headers: {
        "Retry-After": String(error.retryAfterSeconds),
      },
      status: 429,
    },
  );
}
