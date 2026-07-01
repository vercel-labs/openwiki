import {
  readGitHubRepoFile,
  type PreparedRepositoryWorkspace,
} from "../github-repo.js";

type ChatContextSnippet = {
  path: string;
  text: string;
};

const MAX_CHAT_CONTEXT_FILES = 8;
const MAX_CHAT_CONTEXT_FILE_BYTES = 40_000;
const MAX_CHAT_CONTEXT_SNIPPET_CHARS = 8_000;

export async function readChatContext(
  snapshot: PreparedRepositoryWorkspace,
): Promise<ChatContextSnippet[]> {
  const priorityFiles = snapshot.fileInventory
    .filter((file) => isPriorityChatContextPath(file.path) && file.size <= MAX_CHAT_CONTEXT_FILE_BYTES)
    .sort((a, b) => getChatContextPriority(a.path) - getChatContextPriority(b.path))
    .slice(0, MAX_CHAT_CONTEXT_FILES);
  const snippets: ChatContextSnippet[] = [];

  for (const file of priorityFiles) {
    const text = await readGitHubRepoFile(snapshot, file.path);
    snippets.push({
      path: file.path,
      text: text.slice(0, MAX_CHAT_CONTEXT_SNIPPET_CHARS),
    });
  }

  return snippets;
}

function getChatContextPriority(path: string): number {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const depth = segments.length - 1;
  const basename = segments.at(-1) ?? normalized;
  let score = depth;

  if (normalized === "readme.md") return 0;
  if (normalized === "package.json") return 1;
  if (normalized === "tsconfig.json") return 2;

  if (basename === "readme.md") score += 10;
  else if (basename === "package.json") score += 20;
  else if (basename === "index.ts" || basename === "index.tsx") score += 30;
  else if (basename === "main.ts" || basename === "main.tsx") score += 40;
  else score += 100;

  if (segments.includes("packages") || segments.includes("src") || segments.includes("app")) score -= 8;
  if (segments.includes("docs") || segments.includes("examples")) score -= 6;
  if (segments[0]?.startsWith(".")) score += 60;
  if (segments.includes("test") || segments.includes("tests") || basename.includes(".test.")) score += 20;

  return score;
}

function isPriorityChatContextPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    normalized === "readme.md" ||
    normalized === "package.json" ||
    normalized === "tsconfig.json" ||
    normalized.endsWith("/readme.md") ||
    normalized.endsWith("/package.json") ||
    normalized.endsWith("/index.ts") ||
    normalized.endsWith("/index.tsx") ||
    normalized.endsWith("/main.ts") ||
    normalized.endsWith("/main.tsx")
  );
}
