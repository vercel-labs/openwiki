import {
  createOpenWikiOgImage,
  openWikiOgContentType,
  openWikiOgSize,
} from "@/app/lib/openwiki-og-image";
import { getWikiOgData, titleFromWikiSlug } from "@/app/lib/wiki-og-data";
import { getFeaturedWikiSlugStaticParams } from "../../../static-params";

type WikiSlugOgImageProps = {
  params: Promise<{
    owner: string;
    repo: string;
    slug: string;
  }>;
};

export const alt = "OpenWiki wiki page";
export const contentType = openWikiOgContentType;
export const dynamic = "force-static";
export const dynamicParams = true;
export const revalidate = false;
export const size = openWikiOgSize;

export async function generateStaticParams() {
  return await getFeaturedWikiSlugStaticParams();
}

export default async function Image({ params }: WikiSlugOgImageProps) {
  const { owner, repo: repoName, slug } = await params;
  const data = await getWikiOgData({
    fallbackPageTitle: titleFromWikiSlug(slug),
    owner,
    repoName,
    slug,
  });

  return await createOpenWikiOgImage(data);
}
