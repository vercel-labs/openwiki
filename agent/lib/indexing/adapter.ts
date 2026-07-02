import { failIndexJob, getIndexJob, setIndexJobPhase } from "@/lib/storage";
import type { ChannelEvents } from "eve/channels";
import { indexingSessionState } from "./session-state.js";
import { logIndexing } from "./log.js";
import type { IndexAdapterState } from "./types.js";

export type IndexChannelContext = {
  state: IndexAdapterState;
};

export const indexChannelEvents: ChannelEvents<IndexChannelContext> = {
  async "turn.started"(_data, channel, ctx) {
    if (channel.state.repoUrl.length === 0) return;
    if (channel.state.indexJobId.length === 0) return;

    indexingSessionState.update(() => ({
      indexJobId: channel.state.indexJobId,
      repositoryId: channel.state.repositoryId,
      repoUrl: channel.state.repoUrl,
      sessionId: ctx.session.id,
      webUrl: channel.state.webUrl,
    }));
  },

  async "message.completed"(data, channel) {
    if (channel.state.executionMode === "tool") return;
    if (channel.state.role === "worker") return;
    if (typeof data?.message === "string" && data.message.trim().length > 0) {
      channel.state.lastMessage = data.message;
      logIndexing("agent-response-received", channel.state, {
        messageLength: data.message.length,
      });
      await setIndexJobPhase({
        indexJobId: channel.state.indexJobId,
        phase: "agent-response-received",
      });
    }
  },

  async "turn.completed"(_data, channel) {
    if (channel.state.executionMode === "tool") return;
    if (channel.state.role === "worker") return;
    if (channel.state.published === true) return;
    logIndexing("turn-completed", channel.state);
  },

  async "session.completed"(_data, channel, ctx) {
    if (channel.state.executionMode !== "tool") return;
    if (channel.state.indexJobId.length === 0) return;

    const job = await getIndexJob(channel.state.indexJobId);
    if (job === null || job.status === "completed" || job.status === "failed") return;

    const message = "eve indexing session completed before the repository job finished.";
    logIndexing("failed", channel.state, {
      error: message,
      eveSessionId: ctx.session.id,
    });
    await failIndexJob({
      errorMessage: message,
      eveSessionId: ctx.session.id,
      indexJobId: channel.state.indexJobId,
    });
  },

  async "session.failed"(data, channel) {
    if (channel.state.role === "worker") return;
    if (channel.state.published === true) return;
    logIndexing("failed", channel.state, {
      error: data?.message ?? "eve indexing run failed.",
    });
    await failIndexJob({
      errorMessage: data?.message ?? "eve indexing run failed.",
      indexJobId: channel.state.indexJobId,
    });
  },
};

export function createEmptyIndexAdapterState(): IndexAdapterState {
  return {
    branch: "",
    commitSha: "",
    contextSnippets: [],
    fileInventory: [],
    indexJobId: "",
    owner: "",
    repo: "",
    repositoryId: "",
    repoUrl: "",
    skippedFiles: [],
    workspaceManifestPath: "",
  };
}
