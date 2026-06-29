import {
  localDev,
  routeAuth,
  vercelOidc,
  vercelSubject,
  type AuthFn,
} from "eve/channels/auth";

export const openWikiRouteAuth = [
  ...(process.env.NODE_ENV === "development" ? [localDev()] : []),
  vercelOidc(resolveVercelOidcOptions()),
] satisfies readonly AuthFn<Request>[];

export async function authenticateOpenWikiRequest(request: Request) {
  return routeAuth(request, openWikiRouteAuth);
}

function resolveVercelOidcOptions(): Parameters<typeof vercelOidc>[0] {
  const projectName = process.env.OPENWIKI_WEB_PROJECT_NAME;
  const teamSlug = process.env.OPENWIKI_WEB_TEAM_SLUG;

  if (!projectName || !teamSlug) {
    return undefined;
  }

  return {
    subjects: [
      vercelSubject({
        environment: "*",
        projectName,
        teamSlug,
      }),
    ],
  };
}
