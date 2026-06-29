import {
  failIndexJob,
  failStalePreSessionIndexJobsForRepository,
  getActiveIndexJobForRepository,
  type IndexJob,
  type Repository,
  reserveIndexJobForRepository,
} from "@/lib/storage";
import {
  ACTIVE_JOB_STALE_ERROR_MESSAGE,
  getPreSessionStaleBefore,
  isActiveJobStale,
  isPreSessionJobStale,
  PRE_SESSION_STALE_ERROR_MESSAGE,
} from "@/lib/index-job-staleness";
import {
  getEveServerHeaders,
  getOpenWikiEveUrlForWebUrl,
} from "@/lib/eve-client";
import { getOpenWikiWebUrl } from "@/lib/openwiki-web-url";

export type RepositoryIndexingStart = {
  created: boolean;
  job: IndexJob;
  repository: Repository;
};

export async function startRepositoryIndexing(input: {
  beforeCreateJob?: () => Promise<void>;
  repository: Repository;
  request?: Request;
  webUrl?: string;
}): Promise<RepositoryIndexingStart> {
  const { beforeCreateJob, repository, request, webUrl } = input;
  const activeJob = await getActiveIndexJobForRepository(repository.id);

  if (activeJob !== null) {
    if (isPreSessionJobStale(activeJob)) {
      await failStalePreSessionIndexJobsForRepository({
        errorMessage: PRE_SESSION_STALE_ERROR_MESSAGE,
        repositoryId: repository.id,
        staleBefore: getPreSessionStaleBefore(),
      });
    } else if (isActiveJobStale(activeJob)) {
      await failIndexJob({
        errorMessage: ACTIVE_JOB_STALE_ERROR_MESSAGE,
        indexJobId: activeJob.id,
      });
    } else {
      return {
        created: false,
        job: activeJob,
        repository,
      };
    }
  }

  await beforeCreateJob?.();

  const reservation = await reserveIndexJobForRepository(repository.id);
  if (!reservation.created) {
    return {
      created: false,
      job: reservation.job,
      repository,
    };
  }

  const job = reservation.job;
  await dispatchRepositoryIndexing({
    job,
    repository,
    webUrl: getOpenWikiWebUrl({ request, webUrl }),
  });

  return {
    created: true,
    job,
    repository,
  };
}

async function dispatchRepositoryIndexing(input: {
  job: IndexJob;
  repository: Repository;
  webUrl: string;
}) {
  const { job, repository, webUrl } = input;

  try {
    const response = await fetch(getOpenWikiEveUrlForWebUrl(webUrl, "index-repository"), {
      body: JSON.stringify({
        indexJobId: job.id,
        repoUrl: repository.githubUrl,
        repositoryId: repository.id,
        webUrl,
      }),
      headers: {
        ...(await getEveServerHeaders()),
        "content-type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `eve indexing failed with status ${response.status}.`);
    }
  } catch (error) {
    await failIndexJob({
      errorMessage: error instanceof Error ? error.message : "Unknown indexing error.",
      indexJobId: job.id,
    });

    throw error;
  }
}
