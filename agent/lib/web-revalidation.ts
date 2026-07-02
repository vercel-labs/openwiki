import { getVercelOidcToken } from "@vercel/oidc";
import { getOpenWikiWebUrl } from "@/lib/openwiki-web-url";

export async function requestHomeRevalidation(input: {
  webUrl?: string;
} = {}): Promise<void> {
  await requestWebRevalidation({
    body: { kind: "home" },
    webUrl: input.webUrl,
  });
}

export async function requestRepositoryRevalidation(input: {
  owner: string;
  repo: string;
  repositoryId: string;
  revisionId: string;
  webUrl?: string;
}): Promise<void> {
  await requestWebRevalidation({
    body: {
      owner: input.owner,
      repo: input.repo,
      repositoryId: input.repositoryId,
      revisionId: input.revisionId,
    },
    webUrl: input.webUrl,
  });
}

export function getWebRevalidationUrlForLog(requestOrigin?: string): string {
  try {
    return getOpenWikiWebUrl({ webUrl: requestOrigin });
  } catch {
    return "unconfigured";
  }
}

async function requestWebRevalidation(input: {
  body: Record<string, string>;
  webUrl?: string;
}): Promise<void> {
  const webUrl = getOpenWikiWebUrl({ webUrl: input.webUrl });
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const oidcToken = await getServerOidcToken();
  if (oidcToken.length > 0) {
    headers.authorization = `Bearer ${oidcToken}`;
  }
  const protectionBypass =
    process.env.OPENWIKI_WEB_PROTECTION_BYPASS_SECRET ?? process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (protectionBypass !== undefined && protectionBypass.trim().length > 0) {
    headers["x-vercel-protection-bypass"] = protectionBypass;
  }

  const response = await fetch(`${webUrl}/api/internal/revalidate-repository`, {
    body: JSON.stringify(input.body),
    headers,
    method: "POST",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Web revalidation failed with status ${response.status}: ${body.slice(0, 500)}`);
  }
}

async function getServerOidcToken(): Promise<string> {
  try {
    const token = (await getVercelOidcToken()).trim();
    if (token.length > 0) return token;
  } catch {
    // Fall back to env for local development after `vc env pull`.
  }

  return process.env.VERCEL_OIDC_TOKEN?.trim() ?? "";
}
