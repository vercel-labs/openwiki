import { failIndexJob, setIndexJobPhase } from "@/lib/storage";
import type { ChannelEvents } from "eve/channels";
import { prepareRepositoryWorkspace } from "../github-repo.js";
import { logIndexing } from "./log.js";
import type { IndexAdapterState } from "./types.js";

export type IndexChannelContext = {
  state: IndexAdapterState;
};

export const indexChannelEvents: ChannelEvents<IndexChannelContext> = {
  async "turn.started"(_data, channel, ctx) {
    if (channel.state.repoUrl.length === 0) return;

    const sandbox = await ctx.getSandbox();
    if (channel.state.hydratedSandboxId === sandbox.id) return;

    await prepareRepositoryWorkspace(channel.state.repoUrl, sandbox);
    channel.state.hydratedSandboxId = sandbox.id;
  },

  async "message.completed"(data, channel) {
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
    if (channel.state.role === "worker") return;
    if (channel.state.published === true) return;
    logIndexing("turn-completed", channel.state);
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
