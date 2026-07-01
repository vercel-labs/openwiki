import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { withEve } from "eve/next";

const repoRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: repoRoot,
  },
};

export default withEve(nextConfig, {
  eveBuildCommand: "eve build && node lib/patch-eve-vercel-config.mjs",
  eveRoot: ".",
});
