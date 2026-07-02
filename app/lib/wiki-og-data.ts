import {
  getRepositoryWiki,
  isArtifactUnavailableError,
} from "@/lib/storage";
import type { Metadata } from "next";
import { isStorageConfigurationError } from "@/app/lib/storage-error";

type WikiOgDataInput = {
  fallbackPageTitle: string;
  owner: string;
  repoName: string;
  slug?: string;
};

export async function getWikiOgData({
  fallbackPageTitle,
  owner,
  repoName,
  slug,
}: WikiOgDataInput): Promise<{
  pageTitle: string;
  repoLabel: string;
}> {
  const fallback = {
    pageTitle: fallbackPageTitle,
    repoLabel: `${owner}/${repoName}`,
  };

  try {
    const wiki = await getRepositoryWiki({ owner, name: repoName, slug });
    if (wiki === null) return fallback;

    return {
      pageTitle: wiki.currentPage?.title ?? fallbackPageTitle,
      repoLabel: wiki.repository.fullName,
    };
  } catch (error) {
    if (isStorageConfigurationError(error) || isArtifactUnavailableError(error)) {
      return fallback;
    }

    throw error;
  }
}

export function createWikiMetadata({
  pageTitle,
  repoLabel,
}: {
  pageTitle: string;
  repoLabel: string;
}): Metadata {
  const title =
    pageTitle === "Overview"
      ? `${repoLabel} - OpenWiki`
      : `${pageTitle} - ${repoLabel} - OpenWiki`;
  const description = `A living, source-grounded wiki for ${repoLabel}.`;

  return {
    description,
    openGraph: {
      description,
      title,
    },
    title,
    twitter: {
      card: "summary_large_image",
      description,
      title,
    },
  };
}

export function titleFromWikiSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
