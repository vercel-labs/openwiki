import {
  getRepositoryWiki,
  isArtifactUnavailableError,
} from "@/lib/storage";
import {
  getStorageConfigurationErrorMessage,
  isStorageConfigurationError,
} from "@/app/lib/storage-error";
import { parseMarkdownRoute } from "@/app/lib/markdown-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const markdownRoute = parseMarkdownRoute(url.pathname);
  const owner = url.searchParams.get("owner")?.trim() || markdownRoute?.owner;
  const repo = url.searchParams.get("repo")?.trim() || markdownRoute?.repo;
  const slug = url.searchParams.get("slug")?.trim() || markdownRoute?.slug;

  if (!owner || !repo) {
    return new Response("Missing owner or repository.", { status: 400 });
  }

  let wiki;
  try {
    wiki = await getRepositoryWiki({ name: repo, owner, slug });
  } catch (error) {
    if (isStorageConfigurationError(error)) {
      return new Response(getStorageConfigurationErrorMessage(), { status: 503 });
    }
    if (isArtifactUnavailableError(error)) {
      return new Response(error.message, { status: 503 });
    }
    throw error;
  }

  if (wiki === null || wiki.currentPage === null) {
    return new Response("Markdown page not found.", { status: 404 });
  }

  return new Response(wiki.currentPage.markdown, {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "content-disposition": `inline; filename="${getMarkdownFilename({
        owner,
        repo,
        slug: wiki.currentPage.slug,
      })}"`,
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}

function getMarkdownFilename(input: {
  owner: string;
  repo: string;
  slug: string;
}): string {
  return `${input.owner}-${input.repo}-${input.slug}`
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .concat(".md");
}
