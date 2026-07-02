import { NextRequest } from "next/server";
import { z } from "zod";
import {
  chatRateLimitedCode,
  ChatRateLimitError,
  enforceChatRateLimit,
} from "@/lib/chat-rate-limit";
import { parseGitHubRepoUrl } from "@/lib/github-repo-url";
import { storageConfigurationErrorResponse } from "@/app/lib/storage-error";
import { getEveServerHeaders, getOpenWikiEveUrl } from "../eve-client";

export const maxDuration = 800;

const MAX_CHAT_MESSAGE_CHARS = 8_000;
const MAX_CHAT_HISTORY_MESSAGE_CHARS = 4_000;

const chatRequestSchema = z.object({
  history: z
    .array(
      z.object({
        content: z.string().trim().min(1).max(MAX_CHAT_HISTORY_MESSAGE_CHARS),
        role: z.enum(["assistant", "user"]),
      }),
    )
    .max(8)
    .optional(),
  message: z
    .string()
    .trim()
    .min(1, "Message must be a non-empty string.")
    .max(MAX_CHAT_MESSAGE_CHARS, "Message is too long."),
  repoUrl: z.url({ error: "Expected a GitHub repository URL." }),
});

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON request body." }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." }, { status: 400 });
  }

  const repo = parseGitHubRepoUrl(parsed.data.repoUrl);
  if (repo === null) {
    return Response.json({ error: "Expected a public GitHub repository URL." }, { status: 400 });
  }

  try {
    await enforceChatRateLimit({
      repoFullName: repo.fullName,
      request,
    });
  } catch (error) {
    if (error instanceof ChatRateLimitError) {
      return chatRateLimitedResponse(error);
    }

    const response = storageConfigurationErrorResponse(error);
    if (response !== null) return response;

    throw error;
  }

  let response: Response;
  try {
    response = await fetch(getOpenWikiEveUrl(request, "repo-message"), {
      body: JSON.stringify({
        history: parsed.data.history,
        message: parsed.data.message,
        repoUrl: repo.url,
      }),
      headers: {
        ...(await getEveServerHeaders()),
        "content-type": "application/json",
      },
      method: "POST",
    });
  } catch (error) {
    return Response.json(
      {
        error: "Could not reach the embedded eve route. Start the app with `pnpm dev`.",
        detail: getErrorMessage(error),
      },
      { status: 502 },
    );
  }

  const result = (await readJsonResponse(response)) as {
    error?: string;
    session?: {
      continuationToken?: string;
      sessionId?: string;
      streamIndex: number;
    };
  };

  if (!response.ok) {
    return Response.json({ error: result.error ?? "The eve session failed." }, { status: 502 });
  }

  return Response.json({
    repo: {
      name: repo.name,
      owner: repo.owner,
      url: repo.url,
    },
    session: result.session,
  }, { status: 202 });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: text,
    };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chatRateLimitedResponse(error: ChatRateLimitError) {
  return Response.json(
    {
      code: chatRateLimitedCode,
      error: error.message,
      limit: error.limit,
      resetAt: error.resetAt,
      retryAfter: error.retryAfterSeconds,
      scope: error.scope,
    },
    {
      headers: {
        "Retry-After": String(error.retryAfterSeconds),
      },
      status: 429,
    },
  );
}
