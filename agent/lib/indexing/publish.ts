import {
  finishIndexJob,
  publishWikiRevision,
  setIndexJobPhase,
} from "@/lib/storage";
import {
  getWebRevalidationUrlForLog,
  requestRepositoryRevalidation,
} from "../web-revalidation.js";
import { logIndexing } from "./log.js";
import { normalizePages, parseIndexOutput } from "./output.js";
import type { IndexAdapterState } from "./types.js";

export async function completeIndexing(state: IndexAdapterState): Promise<void> {
  if (state.published === true) return;

  if (state.lastMessage === undefined) {
    throw new Error("Indexing run completed without a final typed response.");
  }

  logIndexing("validating-output", state);
  await setIndexJobPhase({ indexJobId: state.indexJobId, phase: "validating-output" });
  const output = parseIndexOutput(state.lastMessage);
  const validPaths = new Set(state.fileInventory.map((file) => file.path));
  const pages = normalizePages(output.pages, validPaths);
  if (pages.length === 0) {
    throw new Error("Indexing run returned no publishable pages.");
  }

  logIndexing("publishing", state, {
    pageCount: pages.length,
  });
  await setIndexJobPhase({ indexJobId: state.indexJobId, phase: "publishing" });
  const revision = await publishWikiRevision({
    branch: state.branch,
    commitSha: state.commitSha,
    fileInventory: state.fileInventory,
    indexJobId: state.indexJobId,
    pages,
    repositoryId: state.repositoryId,
    sourceIndex: {
      officialDocs: state.officialDocs,
      outline: output.outline,
      repositorySummary: output.repositorySummary,
      skippedFiles: state.skippedFiles,
      workspaceManifestPath: state.workspaceManifestPath,
    },
  });

  await finishIndexJob({
    indexJobId: state.indexJobId,
  });
  state.published = true;

  logIndexing("revalidating", state, {
    revisionId: revision.repoRevisionId,
    webUrl: getWebRevalidationUrlForLog(state.webUrl),
  });
  await setIndexJobPhase({ indexJobId: state.indexJobId, phase: "revalidating" });
  await requestRepositoryRevalidation({
    owner: state.owner,
    repo: state.repo,
    repositoryId: state.repositoryId,
    revisionId: revision.repoRevisionId,
    webUrl: state.webUrl,
  })
    .then(() => {
      logIndexing("revalidated", state, {
        revisionId: revision.repoRevisionId,
      });
    })
    .catch((error: unknown) => {
      logIndexing("revalidation-failed", state, {
        error: describeError(error),
        revisionId: revision.repoRevisionId,
        webUrl: getWebRevalidationUrlForLog(state.webUrl),
      });
    });
  await setIndexJobPhase({ indexJobId: state.indexJobId, phase: "completed" });
  logIndexing("completed", state, {
    revisionId: revision.repoRevisionId,
  });
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown revalidation error.";
  const cause = error.cause instanceof Error ? ` Cause: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}
