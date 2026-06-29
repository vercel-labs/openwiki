import { RepositoryWikiPage } from "@/app/repos/[owner]/[repo]/repository-wiki-page";
import {
  createWikiMetadata,
  getWikiOgData,
  titleFromWikiSlug,
} from "@/app/lib/wiki-og-data";
import { getFeaturedWikiSlugStaticParams } from "../../../static-params";

type WikiSlugPageProps = {
  params: Promise<{
    owner: string;
    repo: string;
    slug: string;
  }>;
};

export const dynamic = "force-static";
export const dynamicParams = true;
export const revalidate = false;

export async function generateStaticParams() {
  return await getFeaturedWikiSlugStaticParams();
}

export async function generateMetadata({ params }: WikiSlugPageProps) {
  const { owner, repo: repoName, slug } = await params;
  const data = await getWikiOgData({
    fallbackPageTitle: titleFromWikiSlug(slug),
    owner,
    repoName,
    slug,
  });

  return createWikiMetadata(data);
}

export default async function WikiSlugPage({ params }: WikiSlugPageProps) {
  const { owner, repo: repoName, slug } = await params;
  return <RepositoryWikiPage owner={owner} repoName={repoName} slug={slug} />;
}
