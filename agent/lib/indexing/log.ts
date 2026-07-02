import type { IndexingLogContext } from "./types.js";

export function logIndexing(
  phase: string,
  context: IndexingLogContext,
  details: Record<string, unknown> = {},
): void {
  const fields: Record<string, unknown> = {
    phase,
  };
  if (context.indexJobId !== undefined) fields.indexJobId = context.indexJobId;
  if (context.repositoryId !== undefined) fields.repositoryId = context.repositoryId;
  if (context.eveSessionId !== undefined) fields.eveSessionId = context.eveSessionId;
  if (context.repoUrl !== undefined) fields.repoUrl = context.repoUrl;
  if (context.owner !== undefined && context.repo !== undefined) {
    fields.repository = `${context.owner}/${context.repo}`;
  } else if (context.repo !== undefined) {
    fields.repository = context.repo;
  }

  console.info("[openwiki:index]", JSON.stringify({ ...fields, ...details }));
}
