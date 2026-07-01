import {
  readGitHubRepoFile,
  type PreparedRepositoryWorkspace,
} from "../github-repo.js";
import { isInternalPlanningDocumentationPath } from "./source-paths.js";
import type { ContextSnippet } from "./types.js";

const MAX_CONTEXT_FILES = 100;
const MAX_CONTEXT_FILE_BYTES = 160_000;
const MAX_CONTEXT_SNIPPET_CHARS = 8_000;

export async function readIndexingContext(
  snapshot: PreparedRepositoryWorkspace,
): Promise<ContextSnippet[]> {
  const priorityFiles = snapshot.fileInventory
    .filter((file) => isPriorityContextPath(file.path) && file.size <= MAX_CONTEXT_FILE_BYTES)
    .sort((a, b) => scoreContextFile(b.path) - scoreContextFile(a.path))
    .slice(0, MAX_CONTEXT_FILES);
  const snippets: ContextSnippet[] = [];

  for (const file of priorityFiles) {
    const text = await readGitHubRepoFile(snapshot, file.path);
    snippets.push({
      path: file.path,
      text: text.slice(0, MAX_CONTEXT_SNIPPET_CHARS),
    });
  }

  return snippets;
}

function isPriorityContextPath(path: string): boolean {
  if (isInternalPlanningDocumentationPath(path)) return false;

  const normalized = path.toLowerCase();
  return (
    normalized === "readme" ||
    normalized === "readme.md" ||
    normalized === "readme.mdx" ||
    normalized === "package.json" ||
    normalized === "pnpm-workspace.yaml" ||
    normalized === "pnpm-lock.yaml" ||
    normalized === "lerna.json" ||
    normalized === "turbo.json" ||
    normalized === "cargo.toml" ||
    normalized === ".cargo/config.toml" ||
    normalized === "taskfile.js" ||
    normalized === "taskfile.ts" ||
    normalized === "jest.config.js" ||
    normalized === "jest.config.ts" ||
    normalized === "jest.config.turbopack.js" ||
    normalized === "tsconfig.json" ||
    normalized === "index.ts" ||
    normalized === "index.tsx" ||
    normalized === "index.js" ||
    normalized === "index.jsx" ||
    normalized === "main.ts" ||
    normalized === "main.tsx" ||
    normalized === "main.js" ||
    normalized === "test.js" ||
    normalized === "test.ts" ||
    normalized === "test.tsx" ||
    normalized.endsWith("/readme") ||
    normalized.endsWith("/readme.md") ||
    normalized.endsWith("/readme.mdx") ||
    normalized.endsWith("/package.json") ||
    normalized.endsWith("/cargo.toml") ||
    normalized.endsWith("/taskfile.js") ||
    normalized.endsWith("/taskfile.ts") ||
    normalized.endsWith("/test.js") ||
    normalized.endsWith("/test.ts") ||
    normalized.endsWith("/test.tsx") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.tsx") ||
    normalized.endsWith("/index.ts") ||
    normalized.endsWith("/index.tsx") ||
    normalized.endsWith("/index.js") ||
    normalized.endsWith("/index.jsx") ||
    normalized.endsWith("/main.ts") ||
    normalized.endsWith("/main.tsx") ||
    normalized.endsWith("/main.js") ||
    normalized.startsWith("docs/") ||
    normalized.startsWith("content/docs/") ||
    normalized.startsWith("examples/") ||
    normalized.startsWith("cookbook/") ||
    normalized.startsWith("templates/") ||
    normalized.startsWith(".github/workflows/") ||
    normalized.includes("/src/")
  );
}

function scoreContextFile(path: string): number {
  let score = 0;
  const normalized = path.toLowerCase();
  if (/^readme(\.mdx?)?$/.test(normalized) || normalized === "package.json") score += 1_000;
  if (/(^|\/)readme(\.mdx?)?$/.test(normalized)) score += 950;
  if (/(^|\/)package\.json$/.test(normalized)) score += 900;
  if (/^(pnpm-workspace\.yaml|lerna\.json|turbo\.json|cargo\.toml|\.cargo\/config\.toml|taskfile\.[jt]s|jest\.config)/.test(normalized)) {
    score += 900;
  }
  if (/^packages\/[^/]+\/package\.json$/.test(normalized)) score += 820;
  if (/^packages\/[^/]+\/readme(\.mdx?)?$/.test(normalized)) score += 820;
  if (/^rspack\/package\.json$/.test(normalized)) score += 760;
  if (/^crates\/[^/]+\/cargo\.toml$/.test(normalized)) score += 720;
  if (/^turbopack\/crates\/[^/]+\/cargo\.toml$/.test(normalized)) score += 700;
  if (/^(docs|content\/docs|site\/docs|website\/docs)\//.test(normalized)) score += 760;
  if (/^(examples|cookbook|templates)\//.test(normalized)) score += 560;
  if (/^packages\/[^/]+\/src\/(index|main|mod|lib)\.(ts|tsx|js|jsx|rs)$/.test(normalized)) score += 520;
  if (/^packages\/[^/]+\/src\//.test(normalized)) score += 260;
  if (/^crates\/next-core\//.test(normalized)) score += 220;
  if (/^turbopack\/crates\//.test(normalized)) score += 200;
  if (/(^|\/)(index|main|mod|lib)\.(ts|tsx|js|jsx|rs)$/.test(normalized)) score += 120;
  if (/(^|\/)(migration|migrate|upgrade|troubleshoot|troubleshooting|error|faq|reference|api)\.(mdx?|tsx?)$/.test(normalized)) {
    score += 180;
  }
  if (isGeneratedOrVendorPath(path)) score -= 500;
  if (isFixturePath(path)) score -= 400;
  if (isTestPath(path)) score -= 80;
  if (normalized.startsWith(".github/actions/")) score -= 120;
  return score;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|test|tests|spec)(\/|$)|(\.|-)(test|spec|test-d)\./i.test(path);
}

function isGeneratedOrVendorPath(path: string): boolean {
  return /(^|\/)(node_modules|dist|build|coverage|\.next|compiled|vendor|vendored)(\/|$)/i.test(path);
}

function isFixturePath(path: string): boolean {
  return /(^|\/)(__fixtures__|fixtures|__testfixtures__|test-fixtures|testdata)(\/|$)/i.test(path);
}
