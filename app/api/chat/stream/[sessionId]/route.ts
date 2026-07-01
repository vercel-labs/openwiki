import { NextRequest } from "next/server";
import { getEveServerHeaders, getEveSessionStreamUrl } from "../../../eve-client";

export const maxDuration = 800;

type ChatStreamRouteProps = {
  params: Promise<{
    sessionId: string;
  }>;
};

const START_INDEX_PATTERN = /^\d+$/;

export async function GET(request: NextRequest, { params }: ChatStreamRouteProps) {
  const { sessionId } = await params;
  const startIndex = request.nextUrl.searchParams.get("startIndex") ?? undefined;

  if (sessionId.length === 0) {
    return Response.json({ error: "Session id is required." }, { status: 400 });
  }

  if (startIndex !== undefined && !START_INDEX_PATTERN.test(startIndex)) {
    return Response.json({ error: "startIndex must be a non-negative integer." }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch(getEveSessionStreamUrl({ request, sessionId, startIndex }), {
      headers: await getEveServerHeaders(),
      method: "GET",
      signal: request.signal,
    });
  } catch (error) {
    return Response.json(
      {
        error: "Could not open the eve session stream.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }

  const headers = new Headers();
  headers.set("cache-control", response.headers.get("cache-control") ?? "no-store");
  headers.set("content-type", response.headers.get("content-type") ?? "application/x-ndjson");

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
