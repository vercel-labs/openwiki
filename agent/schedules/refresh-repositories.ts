import { defineSchedule } from "eve/schedules";
import { refreshRepositories } from "@/lib/repository-refresh";
import { requestHomeRevalidation } from "../lib/web-revalidation.js";

export default defineSchedule({
  cron: "0 8 * * *",
  async run({ waitUntil }) {
    waitUntil(runRepositoryRefresh());
  },
});

async function runRepositoryRefresh(): Promise<void> {
  const result = await refreshRepositories();

  try {
    await requestHomeRevalidation();
  } catch (error) {
    console.error("Scheduled repository refresh could not revalidate the home page.", {
      error: error instanceof Error ? error.message : "Unknown revalidation error.",
    });
  }

  console.log("Scheduled repository refresh completed.", {
    enqueueLimit: result.enqueueLimit,
    featuredErrors: result.featured.errors.length,
    generatorEnqueueLimit: result.generatorEnqueueLimit,
    queued: result.queued,
    queuedGeneratorRefreshes: result.queuedGeneratorRefreshes,
    scanned: result.scanned,
  });
}
