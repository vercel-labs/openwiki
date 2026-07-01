import { randomUUID } from "node:crypto";
import type { SendFn } from "eve/channels";
import {
  getGitHubRepoSnapshot,
  parseGitHubRepoUrl,
  type PreparedRepositoryWorkspace,
} from "../github-repo.js";
import { createRepoMessageState, type RepoMessageState } from "./adapter.js";
import { readChatContext } from "./context.js";
import { createRepoMessagePrompt } from "./prompt.js";

type RunAuth = Parameters<SendFn>[1]["auth"];
const MAX_CHAT_SANDBOX_FILES = 36;
const MAX_CHAT_SANDBOX_FILE_BYTES = 180_000;

export type RepoMessageInput = {
  auth: RunAuth;
  history?: Array<{
    content: string;
    role: "assistant" | "user";
  }>;
  message: string;
  repoUrl: string;
  send: SendFn<RepoMessageState>;
};

export type RepoMessageResult = {
  session: {
    continuationToken: string;
    sessionId: string;
    streamIndex: number;
  };
};

// Future improvement: internal or high-traffic repos could start faster from
// precomputed snapshots instead of rebuilding live GitHub context for every
// chat turn. The indexing step could persist the file inventory, priority
// snippets, and maybe a sandbox-ready archive, then repo chat could initialize
// from that exact indexed revision.
export async function startRepoMessage(input: RepoMessageInput): Promise<RepoMessageResult> {
  const repo = parseGitHubRepoUrl(input.repoUrl);
  const snapshot = await getGitHubRepoSnapshot(repo.url);
  const contextSnippets = await readChatContext(snapshot);
  const selectedFilePaths = selectChatSandboxPaths(snapshot, contextSnippets.map((snippet) => snippet.path));
  const session = await input.send(
    {
      message: createRepoMessagePrompt({
        contextSnippets,
        history: input.history,
        message: input.message,
        repo,
        selectedFilePaths,
        snapshot,
      }),
    },
    {
      auth: input.auth,
      continuationToken: `openwiki-chat:${randomUUID()}`,
      mode: "conversation",
      state: createRepoMessageState({
        commitSha: snapshot.commitSha,
        defaultBranch: snapshot.defaultBranch,
        repoUrl: repo.url,
        selectedFilePaths,
      }),
    },
  );

  return {
    session: {
      continuationToken: session.continuationToken,
      sessionId: session.id,
      streamIndex: 0,
    },
  };
}

function selectChatSandboxPaths(
  snapshot: PreparedRepositoryWorkspace,
  contextPaths: string[],
): string[] {
  const paths = new Set(contextPaths);

  for (const file of snapshot.fileInventory
    .filter((entry) => entry.size <= MAX_CHAT_SANDBOX_FILE_BYTES)
    .slice()
    .sort((a, b) => getChatSandboxFilePriority(a.path) - getChatSandboxFilePriority(b.path))) {
    paths.add(file.path);
    if (paths.size >= MAX_CHAT_SANDBOX_FILES) break;
  }

  return [...paths];
}

function getChatSandboxFilePriority(path: string): number {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? normalized;
  const depth = segments.length - 1;
  let score = depth * 8;

  if (normalized === "readme.md") score -= 220;
  if (normalized === "package.json") score -= 210;
  if (normalized === "tsconfig.json") score -= 130;
  if (basename === "readme.md") score -= 110;
  if (basename === "package.json") score -= 100;
  if (basename === "index.ts" || basename === "index.tsx") score -= 80;
  if (basename === "main.ts" || basename === "main.tsx") score -= 70;
  if (segments.includes("docs") || segments.includes("examples")) score -= 40;
  if (segments.includes("packages") || segments.includes("src") || segments.includes("app")) score -= 30;
  if (segments.includes("__tests__") || basename.includes(".test.") || basename.includes(".spec.")) score += 35;
  if (segments[0]?.startsWith(".")) score += 90;
  if (segments[0] === ".github" || segments[0] === ".agents" || segments[0] === ".claude-plugin") {
    score += 80;
  }

  return score;
}
