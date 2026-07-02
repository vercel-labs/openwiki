import { Suspense } from "react";
import { OpenWikiFooter } from "@/app/components/openwiki-footer";
import { RepositoryHome } from "@/app/components/repository-home";
import { getFeaturedRepositoryCards } from "@/app/lib/featured-repository-metadata";

export const dynamic = "force-static";
export const revalidate = false;

export default async function Home() {
  const featuredRepositories = await getFeaturedRepositoryCards({
    fallbackOnStorageConfigurationError: true,
  });

  return (
    <Suspense fallback={null}>
      <RepositoryHome initialFeaturedRepositories={featuredRepositories} />
      <OpenWikiFooter />
    </Suspense>
  );
}
