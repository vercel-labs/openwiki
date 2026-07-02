export const OPENWIKI_REPOSITORY_FULL_NAME = "vercel-labs/openwiki";
export const OPENWIKI_REPOSITORY_URL = `https://github.com/${OPENWIKI_REPOSITORY_FULL_NAME}`;

export const DEPLOY_WITH_VERCEL_URL =
  `https://vercel.com/new/clone?${new URLSearchParams({
    envLink: `${OPENWIKI_REPOSITORY_URL}#environment-variables`,
    "project-name": "openwiki",
    "repository-name": "openwiki",
    "repository-url": `${OPENWIKI_REPOSITORY_URL}/tree/main`,
    stores: JSON.stringify([
      {
        integrationSlug: "neon",
        productSlug: "neon",
        protocol: "storage",
        type: "integration",
      },
      {
        access: "private",
        type: "blob",
      },
    ]),
  }).toString()}`;
