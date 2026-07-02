"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IndexJobProgress, WikiGenerationState } from "./index-job-progress";

type RepositoryAutoIndexProps = {
  repoLabel: string;
  repoUrl: string;
};

type IndexJob = {
  id: string;
};

const repositoryGenerationRateLimitedCode = "repository_generation_rate_limited";
const repositoryCreationDisabledCode = "repository_creation_disabled";

export function RepositoryAutoIndex({ repoLabel, repoUrl }: RepositoryAutoIndexProps) {
  const router = useRouter();
  const startedRepoUrl = useRef<string | null>(null);
  const [job, setJob] = useState<IndexJob | null>(null);
  const [creationDisabledMessage, setCreationDisabledMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitMessage, setRateLimitMessage] = useState<string | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);
  const [isPageVisible, setIsPageVisible] = useState(() => (
    typeof document === "undefined" || document.visibilityState === "visible"
  ));

  useEffect(() => {
    function updateVisibility() {
      setIsPageVisible(document.visibilityState === "visible");
    }

    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  useEffect(() => {
    if (!isPageVisible) return;
    if (startedRepoUrl.current === repoUrl) return;
    startedRepoUrl.current = repoUrl;
    let isActive = true;

    async function ensureIndexing() {
      try {
        const response = await fetch("/api/repositories", {
          body: JSON.stringify({ repoUrl }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const payload = (await response.json()) as {
          code?: string;
          error?: string;
          job?: IndexJob | null;
        };

        if (!response.ok) {
          if (payload.code === repositoryGenerationRateLimitedCode) {
            if (!isActive) return;
            setRateLimitMessage(payload.error ?? "Wiki generation is rate limited. Try again later.");
            setCreationDisabledMessage(null);
            setError(null);
            setJob(null);
            return;
          }
          if (payload.code === repositoryCreationDisabledCode) {
            if (!isActive) return;
            setCreationDisabledMessage(payload.error ?? "Repository creation is disabled for this OpenWiki deployment.");
            setRateLimitMessage(null);
            setError(null);
            setJob(null);
            return;
          }
          throw new Error(payload.error ?? "Could not start wiki generation.");
        }

        if (!isActive) return;
        if (payload.job === null || payload.job === undefined) {
          router.refresh();
          return;
        }

        setJob(payload.job);
        setCreationDisabledMessage(null);
        setError(null);
        setRateLimitMessage(null);
      } catch (caught) {
        if (!isActive) return;
        setError(caught instanceof Error ? caught.message : "Could not start wiki generation.");
        setCreationDisabledMessage(null);
        setRateLimitMessage(null);
      }
    }

    void ensureIndexing();

    return () => {
      isActive = false;
    };
  }, [isPageVisible, repoUrl, router, startAttempt]);

  const restartIndexing = useCallback(() => {
    startedRepoUrl.current = null;
    setCreationDisabledMessage(null);
    setError(null);
    setRateLimitMessage(null);
    setJob(null);
    setStartAttempt((attempt) => attempt + 1);
  }, []);

  if (rateLimitMessage !== null) {
    return (
      <WikiGenerationState
        detail={rateLimitMessage}
        isLoading={false}
        repoLabel={repoLabel}
        stateLabel="Wiki generation is rate limited"
        tone="muted"
      />
    );
  }

  if (creationDisabledMessage !== null) {
    return (
      <WikiGenerationState
        detail={creationDisabledMessage}
        isLoading={false}
        repoLabel={repoLabel}
        stateLabel="Wiki generation disabled"
        tone="muted"
      />
    );
  }

  if (job !== null) {
    return <IndexJobProgress jobId={job.id} onRestartNeeded={restartIndexing} repoLabel={repoLabel} />;
  }

  if (error !== null) {
    return (
      <WikiGenerationState
        detail={error}
        isLoading={false}
        repoLabel={repoLabel}
        stateLabel="Could not start wiki generation"
        tone="destructive"
      />
    );
  }

  if (!isPageVisible) {
    return (
      <WikiGenerationState
        detail="Wiki generation will start when this tab is active."
        isLoading={false}
        repoLabel={repoLabel}
        stateLabel="Waiting for active tab"
        tone="muted"
      />
    );
  }

  return (
    <WikiGenerationState
      repoLabel={repoLabel}
      stateLabel="Starting wiki generation"
    />
  );
}
