import {
  getFeaturedRepositoryCards,
  refreshFeaturedRepositoryMetadata,
} from "@/app/lib/featured-repository-metadata";
import { storageConfigurationErrorResponse } from "@/app/lib/storage-error";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET() {
  try {
    const metadataRefresh = await refreshFeaturedRepositoryMetadata();

    return Response.json({
      metadataRefresh,
      repositories: await getFeaturedRepositoryCards(),
    }, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const response = storageConfigurationErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
