import { getRepositoryWiki } from "@/lib/storage";

type RepositoryRouteProps = {
  params: Promise<{
    owner: string;
    repo: string;
  }>;
};

export async function GET(_request: Request, { params }: RepositoryRouteProps) {
  const { owner, repo } = await params;
  const wiki = await getRepositoryWiki({ name: repo, owner });

  if (wiki === null) {
    return Response.json({ error: "Repository not found." }, { status: 404 });
  }

  return Response.json({ wiki });
}
