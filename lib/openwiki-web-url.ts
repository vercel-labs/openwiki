export function getOpenWikiWebUrl(input: {
  fallback?: string;
  request?: Request;
  webUrl?: string;
} = {}): string {
  const requestOrigin = input.request === undefined ? undefined : new URL(input.request.url).origin;
  const configuredUrl = [
    input.webUrl,
    process.env.OPENWIKI_WEB_URL,
    process.env.WEB_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
    requestOrigin,
  ]
    .map((value) => value?.trim() ?? "")
    .find((value) => value.length > 0);

  if (configuredUrl === undefined) {
    if (process.env.VERCEL === "1") {
      throw new Error(
        "Could not determine the OpenWiki web URL. Set OPENWIKI_WEB_URL or WEB_URL.",
      );
    }

    return input.fallback ?? "http://localhost:3000";
  }

  if (configuredUrl.startsWith("http://") || configuredUrl.startsWith("https://")) {
    return configuredUrl.replace(/\/+$/, "");
  }

  return `https://${configuredUrl.replace(/\/+$/, "")}`;
}
