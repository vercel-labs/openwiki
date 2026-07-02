import type { IndexJob } from "@/lib/storage";

const DEFAULT_PRE_SESSION_STALE_MS = 20 * 60 * 1_000;
const DEFAULT_ACTIVE_JOB_STALE_MS = 15 * 60 * 1_000;

export const PRE_SESSION_STALE_ERROR_MESSAGE =
  "Indexing did not start successfully before the startup timeout. A new run can be started.";
export const ACTIVE_JOB_STALE_ERROR_MESSAGE =
  "Indexing stopped reporting progress before the active job timeout. A new run can be started.";

export function isPreSessionJobStale(job: IndexJob): boolean {
  if (job.eveSessionId !== null) return false;

  const startedAt = Date.parse(job.startedAt);
  if (!Number.isFinite(startedAt)) return false;

  return Date.now() - startedAt > getPreSessionStaleMs();
}

export function isActiveJobStale(job: IndexJob): boolean {
  const updatedAt = Date.parse(job.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;

  return Date.now() - updatedAt > getActiveJobStaleMs();
}

export function getPreSessionStaleBefore(): string {
  return new Date(Date.now() - getPreSessionStaleMs()).toISOString();
}

function getPreSessionStaleMs(): number {
  const configured = Number.parseInt(process.env.OPENWIKI_PRE_SESSION_STALE_MS ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_PRE_SESSION_STALE_MS;
}

function getActiveJobStaleMs(): number {
  const configured = Number.parseInt(process.env.OPENWIKI_ACTIVE_JOB_STALE_MS ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_ACTIVE_JOB_STALE_MS;
}
