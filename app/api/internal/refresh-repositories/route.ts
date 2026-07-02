import { authenticateOpenWikiRequest } from "@/agent/lib/route-auth";
import { requestHomeRevalidation } from "@/agent/lib/web-revalidation";
import { refreshRepositories } from "@/lib/repository-refresh";
import { z } from "zod";

export const maxDuration = 800;

const maxRefreshScanLimit = 500;
const maxRefreshEnqueueLimit = 25;
const maxRefreshGeneratorEnqueueLimit = 50;
const maxRefreshRetryCooldownHours = 24 * 14;

const refreshRequestSchema = z.object({
  enqueueLimit: z.number().int().nonnegative().max(maxRefreshEnqueueLimit).optional(),
  generatorEnqueueLimit: z.number().int().nonnegative().max(maxRefreshGeneratorEnqueueLimit).optional(),
  retryCooldownHours: z.number().int().nonnegative().max(maxRefreshRetryCooldownHours).optional(),
  scanLimit: z.number().int().positive().max(maxRefreshScanLimit).optional(),
}).optional();

export async function POST(request: Request) {
  const authResult = await authenticateOpenWikiRequest(request);
  if (authResult instanceof Response) return authResult;

  let payload: unknown = undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Expected a JSON request body." }, { status: 400 });
    }
  }

  const parsed = refreshRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." }, { status: 400 });
  }

  const result = await refreshRepositories({
    enqueueLimit: parsed.data?.enqueueLimit,
    generatorEnqueueLimit: parsed.data?.generatorEnqueueLimit,
    request,
    retryCooldownHours: parsed.data?.retryCooldownHours,
    scanLimit: parsed.data?.scanLimit,
  });

  try {
    await requestHomeRevalidation({
      webUrl: process.env.NODE_ENV === "development" ? new URL(request.url).origin : undefined,
    });
  } catch (error) {
    console.error("Internal repository refresh could not revalidate the home page.", {
      error: error instanceof Error ? error.message : "Unknown revalidation error.",
    });
  }

  return Response.json({
    ok: true,
    ...result,
  });
}
