import {
  createEmptyRepoMessageState,
  hydrateRepoMessageWorkspace,
  type RepoMessageState,
} from "../lib/repo-message/adapter.js";
import { startRepoMessage } from "../lib/repo-message/run-repo-message.js";
import { authenticateOpenWikiRequest } from "../lib/route-auth.js";
import { defineChannel, POST } from "eve/channels";
import { z } from "zod";

const repoMessageRequestSchema = z.object({
  history: z
    .array(
      z.object({
        content: z.string().trim().min(1),
        role: z.enum(["assistant", "user"]),
      }),
    )
    .max(8)
    .optional(),
  message: z.string().trim().min(1),
  repoUrl: z.url(),
});

export default defineChannel<RepoMessageState, { state: RepoMessageState }>({
  context(state) {
    return { state };
  },
  events: {
    async "turn.started"(_data, channel, ctx) {
      await hydrateRepoMessageWorkspace(channel.state, ctx);
    },
  },
  state: createEmptyRepoMessageState(),
  routes: [
    POST<RepoMessageState>("/eve/v1/openwiki/repo-message", async (request, { send }) => {
      const authResult = await authenticateOpenWikiRequest(request);
      if (authResult instanceof Response) return authResult;

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Expected a JSON request body." }, { status: 400 });
      }

      const parsed = repoMessageRequestSchema.safeParse(payload);
      if (!parsed.success) {
        return Response.json(
          { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
          { status: 400 },
        );
      }

      const result = await startRepoMessage({
        auth: authResult,
        history: parsed.data.history,
        message: parsed.data.message,
        repoUrl: parsed.data.repoUrl,
        send,
      });

      return Response.json(result, { status: 202 });
    }),
  ],
});
