import {
  attachEveSessionToIndexJob,
  failIndexJob,
  getIndexJob,
  setIndexJobPhase,
} from "@/lib/storage";
import type { IndexJob } from "@/lib/storage";
import {
  createEmptyIndexAdapterState,
  indexChannelEvents,
  type IndexChannelContext,
} from "../lib/indexing/adapter.js";
import { logIndexing } from "../lib/indexing/log.js";
import type { IndexAdapterState } from "../lib/indexing/types.js";
import { authenticateOpenWikiRequest } from "../lib/route-auth.js";
import { defineChannel, POST, type SendFn } from "eve/channels";
import { z } from "zod";

const indexRepositoryRoute = "/eve/v1/openwiki/index-repository";

const indexRepositoryRequestSchema = z.object({
  indexJobId: z.string().min(1),
  repositoryId: z.string().min(1),
  repoUrl: z.url(),
  webUrl: z.url().optional(),
});

type IndexRepositoryRequest = z.infer<typeof indexRepositoryRequestSchema>;
type OpenWikiRouteAuth = Exclude<
  Awaited<ReturnType<typeof authenticateOpenWikiRequest>>,
  Response
>;

export default defineChannel<IndexAdapterState, IndexChannelContext>({
  context(state) {
    return { state };
  },
  events: indexChannelEvents,
  state: createEmptyIndexAdapterState(),
  routes: [
    POST<IndexAdapterState>(indexRepositoryRoute, handleIndexRepositoryRequest),
  ],
});

async function handleIndexRepositoryRequest(
  request: Request,
  { send }: { send: SendFn<IndexAdapterState> },
): Promise<Response> {
  const auth = await authenticateOpenWikiRequest(request);
  if (auth instanceof Response) return auth;

  const input = await parseIndexRepositoryRequest(request);
  if (input instanceof Response) return input;

  try {
    const job = await startIndexRepositoryTask({ auth, input, send });
    return createIndexRepositoryResponse(input, job);
  } catch (error) {
    return failIndexRepositoryStartup(input, error);
  }
}

async function parseIndexRepositoryRequest(
  request: Request,
): Promise<IndexRepositoryRequest | Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return createErrorResponse("Expected a JSON request body.", 400);
  }

  const parsed = indexRepositoryRequestSchema.safeParse(payload);
  if (parsed.success) return parsed.data;

  return createErrorResponse(parsed.error.issues[0]?.message ?? "Invalid request body.", 400);
}

async function startIndexRepositoryTask({
  auth,
  input,
  send,
}: {
  auth: OpenWikiRouteAuth;
  input: IndexRepositoryRequest;
  send: SendFn<IndexAdapterState>;
}): Promise<IndexJob> {
  await setIndexJobPhase({ indexJobId: input.indexJobId, phase: "starting-eve-run" });

  const session = await send(createIndexRepositoryTaskMessage(input), {
    auth,
    continuationToken: createIndexRepositoryContinuationToken(input),
    mode: "task",
    state: createIndexRepositoryTaskState(input),
  });

  await attachEveSessionToIndexJob({
    eveSessionId: session.id,
    indexJobId: input.indexJobId,
  });

  const job = await getIndexJob(input.indexJobId);
  if (job !== null) return job;

  throw new Error("Indexing job no longer exists after starting the eve session.");
}

function createIndexRepositoryResponse(input: IndexRepositoryRequest, job: IndexJob): Response {
  return Response.json(
    {
      job,
      repository: {
        id: input.repositoryId,
        url: input.repoUrl,
      },
    },
    { status: 202 },
  );
}

async function failIndexRepositoryStartup(
  input: IndexRepositoryRequest,
  error: unknown,
): Promise<Response> {
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
  return createErrorResponse(message, 502);
}

function createIndexRepositoryTaskState(input: IndexRepositoryRequest): IndexAdapterState {
  return {
    ...createEmptyIndexAdapterState(),
    executionMode: "tool",
    indexJobId: input.indexJobId,
    repositoryId: input.repositoryId,
    repoUrl: input.repoUrl,
    webUrl: input.webUrl,
  };
}

function createIndexRepositoryContinuationToken(input: IndexRepositoryRequest): string {
  return `openwiki-index:${input.indexJobId}`;
}

function createIndexRepositoryTaskMessage(input: IndexRepositoryRequest): string {
  return [
    "Start the OpenWiki repository indexing pipeline.",
    "",
    "You must call the `run_index_repository` tool exactly once with an empty object.",
    "Do not inspect the repository, generate wiki pages yourself, or call any other tool.",
    "After `run_index_repository` returns, reply with one short sentence summarizing the terminal status.",
    "",
    `Index job id: ${input.indexJobId}`,
    `Repository id: ${input.repositoryId}`,
    `Repository URL: ${input.repoUrl}`,
    input.webUrl === undefined ? "" : `OpenWiki web URL: ${input.webUrl}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function createErrorResponse(error: string, status: 400 | 502): Response {
  return Response.json({ error }, { status });
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown indexing startup error.";
  const cause = error.cause instanceof Error ? ` Cause: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}
