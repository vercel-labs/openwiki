import { revalidatePath } from "next/cache";
import { authenticateOpenWikiRequest } from "@/agent/lib/route-auth";
import { getRepoHref } from "@/lib/github-repo-url";
import { getRepositoryWiki } from "@/lib/storage";
import { z } from "zod";

const revalidateHomeSchema = z.object({
  kind: z.literal("home"),
});

const revalidateRepositorySchema = z.object({
  kind: z.literal("repository").optional(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  repositoryId: z.string().min(1),
  revisionId: z.string().min(1),
});

const revalidateRequestSchema = z.union([
  revalidateHomeSchema,
  revalidateRepositorySchema,
]);

export async function POST(request: Request) {
  const authResult = await authenticateOpenWikiRequest(request);
  if (authResult instanceof Response) return authResult;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON request body." }, { status: 400 });
  }

  const parsed = revalidateRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." }, { status: 400 });
  }

  if (parsed.data.kind === "home") {
    revalidatePath("/");
    return Response.json({
      ok: true,
      revalidatedPaths: ["/"],
    });
  }

  const repoHref = getRepoHref({
    name: parsed.data.repo,
    owner: parsed.data.owner,
  });
  revalidatePath("/");
  revalidatePath(repoHref);

  const wiki = await getRepositoryWiki({
    name: parsed.data.repo,
    owner: parsed.data.owner,
  });
  for (const page of wiki?.pages ?? []) {
    if (page.slug !== "overview") {
      revalidatePath(`${repoHref}/${page.slug}`);
    }
  }

  return Response.json({
    ok: true,
    repositoryId: parsed.data.repositoryId,
    revisionId: parsed.data.revisionId,
  });
}
