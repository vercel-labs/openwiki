import { getIndexJob } from "@/lib/storage";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { indexingSessionState } from "../lib/indexing/session-state.js";
import { runIndexRepositoryJob } from "../lib/indexing/run-index-job.js";

export default defineTool({
  description:
    "Run the server-authorized OpenWiki repository indexing pipeline for the current indexing session. Only call when the index-repository channel asks you to start indexing.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const state = indexingSessionState.get();

    if (state === null || state.sessionId !== ctx.session.id) {
      throw new Error(
        "run_index_repository is only available inside an authorized indexing session.",
      );
    }

    await runIndexRepositoryJob({
      indexJobId: state.indexJobId,
      repositoryId: state.repositoryId,
      repoUrl: state.repoUrl,
      webUrl: state.webUrl,
    });

    const job = await getIndexJob(state.indexJobId);
    if (job === null) {
      throw new Error("Indexing job no longer exists.");
    }

    if (job.status === "failed") {
      throw new Error(job.errorMessage ?? "Indexing job failed.");
    }

    return {
      indexJobId: job.id,
      phase: job.phase,
      repositoryId: job.repositoryId,
      status: job.status,
    };
  },
});
