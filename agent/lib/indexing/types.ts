import type { PreparedRepositoryWorkspace, SourceFileInventoryEntry } from "../github-repo.js";

export const MAX_WIKI_PAGES = 128;

export type ContextSnippet = {
  path: string;
  text: string;
};

export type OfficialDocsMetadata = {
  discoveredFrom: string;
  entries: Array<{
    group?: string;
    title: string;
    url: string;
  }>;
  headingCount: number;
  linkCount: number;
  sourceUrl: string;
};

export type IndexAdapterState = {
  branch: string;
  commitSha: string;
  contextSnippets: ContextSnippet[];
  executionMode?: "tool";
  fileInventory: SourceFileInventoryEntry[];
  indexJobId: string;
  hydratedSandboxId?: string;
  lastMessage?: string;
  published?: boolean;
  owner: string;
  repo: string;
  repositoryId: string;
  role?: "root" | "worker";
  repoUrl: string;
  officialDocs?: OfficialDocsMetadata;
  skippedFiles: PreparedRepositoryWorkspace["skippedFiles"];
  webUrl?: string;
  workspaceManifestPath: string;
};

export type IndexingLogContext = Partial<IndexAdapterState> & {
  eveSessionId?: string;
  repo?: string;
};
