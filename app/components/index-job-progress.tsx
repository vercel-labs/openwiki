"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Loader, PauseCircle } from "lucide-react";

type IndexJob = {
  eveSessionId: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  phase: string | null;
  status: "pending" | "running" | "completed" | "failed";
};

type IndexJobProgressProps = {
  jobId: string;
  onRestartNeeded?: () => void;
  repoLabel?: string;
};

type WikiGenerationStateProps = {
  detail?: string | null;
  isLoading?: boolean;
  repoLabel: string;
  stateLabel: string;
  tone?: "default" | "destructive" | "muted";
};

const PHASE_LABELS: Record<string, string> = {
  "agent-response-received": "Agent response received",
  completed: "Wiki published",
  created: "Index job queued",
  failed: "Indexing failed",
  "fetching-repository": "Reading GitHub repository",
  "generating-pages": "Generating wiki pages",
  "outlining-wiki": "Planning wiki structure (a couple minutes)",
  publishing: "Publishing wiki",
  "reading-context": "Preparing source context",
  revalidating: "Refreshing static pages",
  "starting-eve-run": "Starting eve agent",
  "waiting-for-agent": "Generating wiki with eve",
};

export function IndexJobProgressFromSearchParams() {
  const searchParams = useSearchParams();
  const jobId = searchParams.get("job");

  if (jobId === null || jobId.length === 0) {
    return null;
  }

  return <IndexJobProgress jobId={jobId} />;
}

export function IndexJobProgress({ jobId, onRestartNeeded, repoLabel }: IndexJobProgressProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [job, setJob] = useState<IndexJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCount, setErrorCount] = useState(0);

  useEffect(() => {
    let isActive = true;

    async function pollJob() {
      try {
        const response = await fetch(`/api/index-jobs/${jobId}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: IndexJob;
          restart?: boolean;
        };

        if (!response.ok || payload.job === undefined) {
          throw new Error(payload.error ?? "Could not load indexing progress.");
        }

        if (!isActive) return;
        if (payload.restart === true && onRestartNeeded !== undefined) {
          onRestartNeeded();
          return;
        }

        setJob(payload.job);
        setError(null);
        setErrorCount(0);

        if (payload.job.status === "completed") {
          router.replace(pathname);
          router.refresh();
        }
      } catch (caught) {
        if (!isActive) return;
        setError(caught instanceof Error ? caught.message : "Could not load indexing progress.");
        setErrorCount((count) => count + 1);
      }
    }

    void pollJob();
    const interval = window.setInterval(pollJob, 2_000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [jobId, onRestartNeeded, pathname, router]);

  const hasPersistentPollingError = error !== null && errorCount >= 3;
  const isJobFailed = job?.status === "failed";
  const phaseLabel = useMemo(() => {
    if (isJobFailed) return "Indexing failed";
    if (error !== null && job === null) {
      return hasPersistentPollingError ? "Progress unavailable" : "Checking wiki progress";
    }
    if (job === null) return "Loading progress";
    const phase = job.phase === "failed" ? job.status : (job.phase ?? job.status);
    return PHASE_LABELS[phase] ?? phase;
  }, [error, hasPersistentPollingError, isJobFailed, job]);
  const failedMessage = isJobFailed ? job.errorMessage : hasPersistentPollingError ? error : null;
  const isUnavailable = hasPersistentPollingError && job === null;

  return (
    <WikiGenerationState
      detail={failedMessage}
      isLoading={!isJobFailed && !isUnavailable}
      repoLabel={repoLabel ?? getRepoLabelFromPathname(pathname)}
      stateLabel={phaseLabel}
      tone={isJobFailed ? "destructive" : isUnavailable ? "muted" : "default"}
    />
  );
}

export function WikiGenerationState({
  detail = null,
  isLoading = true,
  repoLabel,
  stateLabel,
  tone = "default",
}: WikiGenerationStateProps) {
  const iconClassName =
    tone === "destructive"
      ? "text-destructive"
      : tone === "muted"
        ? "text-muted-foreground"
        : "text-foreground";
  const titleClassName =
    tone === "destructive"
      ? "text-destructive"
      : tone === "muted"
        ? "text-muted-foreground"
        : "text-foreground";

  return (
    <section aria-live="polite" className="grid w-full max-w-[420px] justify-items-center gap-4 text-center">
      <div
        className={`grid size-10 place-items-center rounded-full border bg-background shadow-sm ${iconClassName}`}
      >
        {isLoading ? (
          <Loader aria-hidden="true" className="size-5 animate-spin" />
        ) : tone === "muted" ? (
          <PauseCircle aria-hidden="true" className="size-5" />
        ) : (
          <AlertCircle aria-hidden="true" className="size-5" />
        )}
      </div>
      <div className="grid max-w-full justify-items-center gap-3">
        <h1 className={`m-0 max-w-64 text-balance text-lg leading-6 font-medium tracking-normal ${titleClassName}`}>
          {stateLabel}
        </h1>
        <p className="m-0 max-w-full truncate rounded-md bg-muted/70 px-2 py-1 font-mono text-sm text-muted-foreground">
          {repoLabel}
        </p>
      </div>
      {detail === null ? null : (
        <p className="m-0 max-w-[34rem] text-sm leading-6 text-muted-foreground">{detail}</p>
      )}
    </section>
  );
}

function getRepoLabelFromPathname(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const [firstSegment, secondSegment, thirdSegment] = segments;

  if (firstSegment === "repos" && secondSegment !== undefined && thirdSegment !== undefined) {
    return `${decodeURIComponent(secondSegment)}/${decodeURIComponent(thirdSegment)}`;
  }

  if (firstSegment !== undefined && secondSegment !== undefined) {
    return `${decodeURIComponent(firstSegment)}/${decodeURIComponent(secondSegment)}`;
  }

  return "Repository";
}
