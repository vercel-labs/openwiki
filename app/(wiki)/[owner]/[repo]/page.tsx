import { RepositoryWikiPage } from "@/app/repos/[owner]/[repo]/repository-wiki-page";
import { createWikiMetadata, getWikiOgData } from "@/app/lib/wiki-og-data";
import { getFeaturedWikiStaticParams } from "../../static-params";

type WikiPageProps = {
  params: Promise<{
    owner: string;
    repo: string;
  }>;
};

export const dynamic = "force-static";
export const dynamicParams = true;
export const revalidate = false;

export function generateStaticParams() {
  return getFeaturedWikiStaticParams();
}

export async function generateMetadata({ params }: WikiPageProps) {
  const { owner, repo: repoName } = await params;
  const data = await getWikiOgData({
    fallbackPageTitle: "Overview",
    owner,
    repoName,
  });

  return createWikiMetadata(data);
}

export default async function WikiPage({ params }: WikiPageProps) {
  const { owner, repo: repoName } = await params;
  return <RepositoryWikiPage owner={owner} repoName={repoName} />;
}
