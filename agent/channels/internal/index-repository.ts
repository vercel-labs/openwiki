import { failIndexJob } from "@/lib/storage";
import {
  createEmptyIndexAdapterState,
  indexChannelEvents,
  type IndexChannelContext,
} from "../../lib/indexing/adapter.js";
import { logIndexing } from "../../lib/indexing/log.js";
import { runIndexRepositoryJob } from "../../lib/indexing/run-index-job.js";
import type { IndexAdapterState } from "../../lib/indexing/types.js";
import { authenticateOpenWikiRequest } from "../../lib/route-auth.js";
import { defineChannel, POST } from "eve/channels";
import { z } from "zod";

const indexRepositoryRequestSchema = z.object({
  indexJobId: z.string().min(1),
  repositoryId: z.string().min(1),
  repoUrl: z.url(),
  webUrl: z.url().optional(),
});

export default defineChannel<IndexAdapterState, IndexChannelContext>({
  context(state) {
    return { state };
  },
  events: indexChannelEvents,
  state: createEmptyIndexAdapterState(),
  routes: [
    POST<IndexAdapterState>(
      "/eve/v1/openwiki/index-repository",
      async (request, { waitUntil }) => {
        const authResult = await authenticateOpenWikiRequest(request);
        if (authResult instanceof Response) return authResult;

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "Expected a JSON request body." }, { status: 400 });
        }

        const parsed = indexRepositoryRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return Response.json(
            { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
            { status: 400 },
          );
        }

        const input = parsed.data;
        const indexPromise = runIndexRepositoryJob({
          indexJobId: input.indexJobId,
          repositoryId: input.repositoryId,
          repoUrl: input.repoUrl,
          webUrl: input.webUrl,
        }).catch(async (error: unknown) => {
          const message = describeError(error);
          logIndexing(
            "failed",
            {
              indexJobId: input.indexJobId,
              repositoryId: input.repositoryId,
              repoUrl: input.repoUrl,
            },
            {
              error: message,
            },
          );
          await failIndexJob({
            errorMessage: message,
            indexJobId: input.indexJobId,
          });
        });

        try {
          waitUntil(indexPromise);
        } catch (error) {
          const message = describeError(error);
          await failIndexJob({
            errorMessage: message,
            indexJobId: input.indexJobId,
          });
          return Response.json({ error: message }, { status: 502 });
        }

        return Response.json(
          {
            job: {
              eveSessionId: null,
              id: input.indexJobId,
              phase: "created",
              status: "running",
            },
            repository: {
              id: input.repositoryId,
              url: input.repoUrl,
            },
          },
          { status: 202 },
        );
      },
    ),
  ],
});

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown indexing startup error.";
  const cause = error.cause instanceof Error ? ` Cause: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}
