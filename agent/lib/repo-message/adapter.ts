import type { SessionContext } from "eve/context";
import { prepareRepositoryWorkspaceSelection } from "../github-repo.js";

export type RepoMessageState = {
  commitSha?: string;
  defaultBranch?: string;
  hydratedSandboxId?: string;
  repoUrl: string;
  selectedFilePaths?: string[];
};

export function createRepoMessageState(input: {
  commitSha?: string;
  defaultBranch?: string;
  repoUrl: string;
  selectedFilePaths?: string[];
}): RepoMessageState {
  return input;
}

export function createEmptyRepoMessageState(): RepoMessageState {
  return { repoUrl: "" };
}

export async function hydrateRepoMessageWorkspace(
  state: RepoMessageState,
  ctx: SessionContext,
): Promise<void> {
  if (state.repoUrl.length === 0) return;

  const sandbox = await ctx.getSandbox();
  if (state.hydratedSandboxId === sandbox.id) return;

  if (
    state.commitSha === undefined ||
    state.defaultBranch === undefined ||
    state.selectedFilePaths === undefined
  ) {
    return;
  }

  await prepareRepositoryWorkspaceSelection(
    {
      commitSha: state.commitSha,
      defaultBranch: state.defaultBranch,
      filePaths: state.selectedFilePaths,
      repoUrl: state.repoUrl,
    },
    sandbox,
  );
  state.hydratedSandboxId = sandbox.id;
}
