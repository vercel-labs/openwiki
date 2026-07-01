import {
  createOpenWikiOgImage,
  openWikiOgContentType,
  openWikiOgSize,
} from "@/app/lib/openwiki-og-image";

export const alt = "OpenWiki";
export const contentType = openWikiOgContentType;
export const size = openWikiOgSize;

export default async function Image() {
  return await createOpenWikiOgImage({
    pageTitle: "Living docs for your codebase",
  });
}
