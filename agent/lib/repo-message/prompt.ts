import type { GitHubRepoRef, PreparedRepositoryWorkspace } from "../github-repo.js";

type ChatContextSnippet = {
  path: string;
  text: string;
};

type ChatHistoryMessage = {
  content: string;
  role: "assistant" | "user";
};

export function createRepoMessagePrompt(input: {
  contextSnippets: ChatContextSnippet[];
  history?: ChatHistoryMessage[];
  message: string;
  repo: GitHubRepoRef;
  selectedFilePaths: string[];
  snapshot: PreparedRepositoryWorkspace;
}): string {
  const { contextSnippets, history = [], message, repo, selectedFilePaths, snapshot } = input;
  const inventory = selectChatInventory(snapshot.fileInventory);
  return [
    `Selected repository: ${repo.url}`,
    `Repository full name: ${repo.owner}/${repo.repo}`,
    `Default branch: ${snapshot.defaultBranch}`,
    `Commit SHA: ${snapshot.commitSha}`,
    `Prepared workspace: /workspace/${repo.workspacePath}`,
    `Workspace manifest: /workspace/${repo.workspacePath}/.openwiki/manifest.json`,
    "",
    "Answer from the deterministic file inventory and snippets below.",
    "A selected snapshot subset is hydrated in the sandbox workspace before this turn starts.",
    "Use the sandbox files for exact source checks when relevant, and use the file inventory to recommend nearby files that were not hydrated.",
    "Cite repository-relative file paths for source-grounded claims.",
    "This is an interactive repository chat turn, not a wiki generation turn.",
    "Do not return JSON, outline objects, page drafts, or schema-shaped output.",
    "Answer in polished Markdown prose that directly addresses the user's question.",
    "Keep answers concise unless the user asks for a deep dive.",
    "For direct file-location questions, answer in one short paragraph and a short list of exact paths.",
    "Only recommend or cite paths that appear in the file inventory or context snippets.",
    "Do not use markdown links for repository files; render file paths in backticks instead.",
    "For learning-path questions, prioritize product docs, package docs, public entrypoints, and core source over hidden workflow, agent, bot, or CI files unless the user asks about contribution automation.",
    "If the inventory and snippets are not enough for a precise claim, say which listed files the reader should inspect next instead of guessing.",
    "",
    "File inventory:",
    inventory
      .map((file) => `- ${file.path} (${file.language}, ${file.size} bytes)`)
      .join("\n"),
    "",
    "Hydrated sandbox files:",
    selectedFilePaths.length === 0
      ? "- No files were selected for sandbox hydration."
      : selectedFilePaths.map((path) => `- ${path}`).join("\n"),
    "",
    "Context snippets:",
    contextSnippets.length === 0
      ? "- No small priority files were available."
      : contextSnippets.map((snippet) => `--- ${snippet.path} ---\n${snippet.text}`).join("\n\n"),
    "",
    "Recent conversation:",
    history.length === 0
      ? "- No previous turns in this chat."
      : history.map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.content}`).join("\n\n"),
    "",
    `User question: ${message}`,
  ].join("\n");
}

function selectChatInventory(files: PreparedRepositoryWorkspace["fileInventory"]) {
  return files
    .slice()
    .sort((a, b) => getChatInventoryPriority(a.path) - getChatInventoryPriority(b.path))
    .slice(0, 180);
}

function getChatInventoryPriority(path: string): number {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? normalized;
  const depth = segments.length - 1;
  let score = depth * 8;

  if (normalized === "readme.md") score -= 200;
  if (normalized === "package.json") score -= 190;
  if (normalized === "tsconfig.json") score -= 120;
  if (basename === "readme.md") score -= 100;
  if (basename === "package.json") score -= 90;
  if (basename === "index.ts" || basename === "index.tsx") score -= 70;
  if (basename === "main.ts" || basename === "main.tsx") score -= 60;
  if (segments.includes("docs") || segments.includes("examples")) score -= 35;
  if (segments.includes("packages") || segments.includes("src") || segments.includes("app")) score -= 25;
  if (segments.includes("__tests__") || basename.includes(".test.") || basename.includes(".spec.")) score += 35;
  if (segments[0]?.startsWith(".")) score += 90;
  if (segments[0] === ".github" || segments[0] === ".agents" || segments[0] === ".claude-plugin") {
    score += 80;
  }
  if (segments.includes("node_modules") || segments.includes("dist") || segments.includes("build")) score += 100;

  return score;
}
