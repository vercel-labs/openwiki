import { getFeaturedRepositoryCards } from "@/app/lib/featured-repository-metadata";
import { storageConfigurationErrorResponse } from "@/app/lib/storage-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({
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
