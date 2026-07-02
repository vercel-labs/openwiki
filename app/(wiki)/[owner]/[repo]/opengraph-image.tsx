import {
  createOpenWikiOgImage,
  openWikiOgContentType,
  openWikiOgSize,
} from "@/app/lib/openwiki-og-image";
import { getWikiOgData } from "@/app/lib/wiki-og-data";
import { getFeaturedWikiStaticParams } from "../../static-params";

type WikiOgImageProps = {
  params: Promise<{
    owner: string;
    repo: string;
  }>;
};

export const alt = "OpenWiki repository wiki";
export const contentType = openWikiOgContentType;
export const dynamic = "force-static";
export const dynamicParams = true;
export const revalidate = false;
export const size = openWikiOgSize;

export function generateStaticParams() {
  return getFeaturedWikiStaticParams();
}

export default async function Image({ params }: WikiOgImageProps) {
  const { owner, repo: repoName } = await params;
  const data = await getWikiOgData({
    fallbackPageTitle: "Overview",
    owner,
    repoName,
  });

  return await createOpenWikiOgImage(data);
}
