import { getVercelOidcToken } from "@vercel/oidc";
import { getOpenWikiWebUrl } from "./openwiki-web-url";

const OPENWIKI_EVE_ROUTE_PREFIX = "/eve/v1/openwiki";
const EVE_SESSION_ROUTE_PREFIX = "/eve/v1/session";

export function getOpenWikiEveUrl(request: Request, path: string): string {
  return getOpenWikiEveUrlForWebUrl(getOpenWikiWebUrl({ request }), path);
}

export function getOpenWikiEveUrlForWebUrl(webUrl: string, path: string): string {
  const routePath = path.replace(/^\/+/, "");
  return `${webUrl}${OPENWIKI_EVE_ROUTE_PREFIX}/${routePath}`;
}

export function getEveSessionStreamUrl({
  request,
  sessionId,
  startIndex,
}: {
  request: Request;
  sessionId: string;
  startIndex?: string;
}): string {
  const webUrl = getOpenWikiWebUrl({ request });
  const url = new URL(
    `${webUrl}${EVE_SESSION_ROUTE_PREFIX}/${encodeURIComponent(sessionId)}/stream`,
  );

  if (startIndex !== undefined) {
    url.searchParams.set("startIndex", startIndex);
  }

  return url.toString();
}

export async function getEveServerHeaders(): Promise<Record<string, string>> {
  const headers = getEveProtectionHeaders();
  const token = await getEveServerOidcToken();

  if (token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }

  return headers;
}

function getEveProtectionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const protectionBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  if (protectionBypassSecret !== undefined && protectionBypassSecret.trim().length > 0) {
    headers["x-vercel-protection-bypass"] = protectionBypassSecret;
  }

  return headers;
}

async function getEveServerOidcToken(): Promise<string> {
  try {
    const token = (await getVercelOidcToken()).trim();

    if (token.length > 0) {
      return token;
    }
  } catch {
    // Fall back to env for local development after `vc env pull`.
  }

  return process.env.VERCEL_OIDC_TOKEN?.trim() ?? "";
}
