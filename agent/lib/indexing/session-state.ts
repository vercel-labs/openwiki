import { defineState } from "eve/context";

export type IndexingSessionState = {
  indexJobId: string;
  repositoryId: string;
  repoUrl: string;
  sessionId: string;
  webUrl?: string;
};

export const indexingSessionState = defineState<IndexingSessionState | null>(
  "openwiki.indexingSession",
  () => null,
);
