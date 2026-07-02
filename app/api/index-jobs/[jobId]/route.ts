import { ACTIVE_JOB_STALE_ERROR_MESSAGE, isActiveJobStale } from "@/lib/index-job-staleness";
import { failIndexJob, getActiveIndexJobForRepository, getIndexJob } from "@/lib/storage";

type IndexJobRouteProps = {
  params: Promise<{
    jobId: string;
  }>;
};

export async function GET(_request: Request, { params }: IndexJobRouteProps) {
  const { jobId } = await params;
  const job = await getIndexJob(jobId);

  if (job === null) {
    return Response.json({ error: "Index job not found." }, { status: 404 });
  }

  if ((job.status === "pending" || job.status === "running") && isActiveJobStale(job)) {
    await failIndexJob({
      errorMessage: ACTIVE_JOB_STALE_ERROR_MESSAGE,
      indexJobId: job.id,
    });
    const failedJob = await getIndexJob(job.id);
    return Response.json({ job: failedJob ?? job, restart: true });
  }

  if (job.status === "failed") {
    const activeJob = await getActiveIndexJobForRepository(job.repositoryId);
    if (activeJob !== null && activeJob.id !== job.id) {
      return Response.json({ job: activeJob });
    }
  }

  return Response.json({ job });
}
