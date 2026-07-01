import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";

const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i;
const SAFE_REPO_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;
const GITHUB_API_TIMEOUT_MS = 20_000;
const GITHUB_RAW_FILE_TIMEOUT_MS = 20_000;
const MAX_SEEDED_FILES = 25_000;
const MAX_SEEDED_FILE_BYTES = 512_000;

export type GitHubRepoRef = {
  owner: string;
  repo: string;
  url: string;
  workspacePath: string;
};

export type EnsuredGitHubRepo = GitHubRepoRef & {
  commitSha: string;
  defaultBranch: string;
};

export type GitHubTreeFile = {
  path: string;
  sha: string;
  size: number;
};

export type SourceFileInventoryEntry = {
  path: string;
  language: string;
  size: number;
  hash: string;
};

export type PreparedRepositoryWorkspace = EnsuredGitHubRepo & {
  description?: string;
  fileInventory: SourceFileInventoryEntry[];
  homepageUrl?: string;
  skippedFiles: Array<{
    path: string;
    reason: string;
    size: number;
  }>;
  topics: string[];
};

export function parseGitHubRepoUrl(value: string): GitHubRepoRef {
  const match = GITHUB_URL_PATTERN.exec(value.trim());
  if (match === null) {
    throw new Error("Expected a public GitHub repository URL.");
  }

  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");

  if (!SAFE_REPO_PART_PATTERN.test(owner) || !SAFE_REPO_PART_PATTERN.test(repo)) {
    throw new Error("GitHub repository owner and name may only contain letters, numbers, dots, dashes, and underscores.");
  }

  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
    workspacePath: `repos/${owner}/${repo}`,
  };
}

export async function getGitHubRepoSnapshot(repoUrl: string): Promise<PreparedRepositoryWorkspace> {
  const repo = parseGitHubRepoUrl(repoUrl);
  const metadata = await fetchGitHubRepoMetadata(repo);
  const files = await listGitHubRepoFiles({
    ...repo,
    commitSha: metadata.commitSha,
    defaultBranch: metadata.defaultBranch,
  });

  const selectedFiles = files.slice(0, MAX_SEEDED_FILES);
  const fileInventory = selectedFiles
    .filter((file) => file.size <= MAX_SEEDED_FILE_BYTES)
    .map((file) => ({
      hash: file.sha,
      language: detectLanguage(file.path),
      path: file.path,
      size: file.size,
    }));
  const skippedFiles = [
    ...selectedFiles
      .filter((file) => file.size > MAX_SEEDED_FILE_BYTES)
      .map((file) => ({
        path: file.path,
        reason: "file_too_large",
        size: file.size,
      })),
    ...files.slice(MAX_SEEDED_FILES).map((file) => ({
      path: file.path,
      reason: "file_limit_exceeded",
      size: file.size,
    })),
  ];

  return {
    ...repo,
    commitSha: metadata.commitSha,
    defaultBranch: metadata.defaultBranch,
    description: metadata.description,
    fileInventory,
    homepageUrl: metadata.homepageUrl,
    skippedFiles,
    topics: metadata.topics,
  };
}

export async function prepareRepositoryWorkspace(
  repoUrl: string,
  sandbox: SandboxSession,
): Promise<PreparedRepositoryWorkspace> {
  const snapshot = await getGitHubRepoSnapshot(repoUrl);

  await sandbox.run({
    command: `mkdir -p ${shellQuote(sandbox.resolvePath(`${snapshot.workspacePath}/.openwiki`))}`,
  });

  for (const file of snapshot.fileInventory) {
    const content = await readGitHubRepoFile(snapshot, file.path);
    await sandbox.writeTextFile({
      content,
      path: `${snapshot.workspacePath}/${file.path}`,
    });
  }

  const manifest = {
    commitSha: snapshot.commitSha,
    defaultBranch: snapshot.defaultBranch,
    files: snapshot.fileInventory,
    generatedAt: new Date().toISOString(),
    limits: {
      maxFileBytes: MAX_SEEDED_FILE_BYTES,
      maxSeededFiles: MAX_SEEDED_FILES,
    },
    repoUrl: snapshot.url,
    skippedFiles: snapshot.skippedFiles,
    workspacePath: `/workspace/${snapshot.workspacePath}`,
  };

  await sandbox.writeTextFile({
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    path: `${snapshot.workspacePath}/.openwiki/manifest.json`,
  });

  return snapshot;
}

export async function prepareRepositoryWorkspaceSelection(
  input: {
    commitSha: string;
    defaultBranch: string;
    filePaths: string[];
    repoUrl: string;
  },
  sandbox: SandboxSession,
): Promise<void> {
  const repo = {
    ...parseGitHubRepoUrl(input.repoUrl),
    commitSha: input.commitSha,
    defaultBranch: input.defaultBranch,
  };
  const selectedPaths = [...new Set(input.filePaths.map((path) => normalizeRepoPath(path)))];
  const hydratedFiles: string[] = [];
  const skippedFiles: Array<{ error: string; path: string }> = [];

  await sandbox.run({
    command: `mkdir -p ${shellQuote(sandbox.resolvePath(`${repo.workspacePath}/.openwiki`))}`,
  });

  for (const path of selectedPaths) {
    try {
      const content = await readGitHubRepoFile(repo, path);
      await sandbox.writeTextFile({
        content,
        path: `${repo.workspacePath}/${path}`,
      });
      hydratedFiles.push(path);
    } catch (error) {
      skippedFiles.push({
        error: error instanceof Error ? error.message : String(error),
        path,
      });
    }
  }

  const manifest = {
    commitSha: repo.commitSha,
    defaultBranch: repo.defaultBranch,
    generatedAt: new Date().toISOString(),
    hydratedFiles,
    hydrationMode: "chat-selection",
    repoUrl: repo.url,
    skippedFiles,
    workspacePath: `/workspace/${repo.workspacePath}`,
  };

  await sandbox.writeTextFile({
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    path: `${repo.workspacePath}/.openwiki/manifest.json`,
  });
}

export async function listGitHubRepoFiles(repo: EnsuredGitHubRepo): Promise<GitHubTreeFile[]> {
  const tree = await fetchGitHubJson<{
    tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
    truncated?: boolean;
  }>(`https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${repo.commitSha ?? repo.defaultBranch}?recursive=1`);

  return (tree.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string")
    .map((entry) => ({
      path: normalizeRepoPath(entry.path ?? ""),
      sha: entry.sha ?? "",
      size: entry.size ?? 0,
    }))
    .filter((entry) => isUsefulSourcePath(entry.path));
}

export async function readGitHubRepoFile(repo: EnsuredGitHubRepo, path: string): Promise<string> {
  const safePath = normalizeRepoPath(path);
  const response = await fetch(
    `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.commitSha ?? repo.defaultBranch}/${safePath}`,
    {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(GITHUB_RAW_FILE_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`Could not read ${safePath} from ${repo.owner}/${repo.repo}: ${response.status}`);
  }

  return await response.text();
}

export function normalizeRepoPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");

  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    parts.includes("..") ||
    parts.includes(".")
  ) {
    throw new Error("Expected a repository-relative file path.");
  }

  return normalized;
}

export function detectLanguage(path: string): string {
  const basename = path.split("/").at(-1)?.toLowerCase();
  if (basename === "readme") return "markdown";

  const extension = path.split(".").at(-1)?.toLowerCase();

  switch (extension) {
    case "css":
      return "css";
    case "go":
      return "go";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "markdown";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "ts":
    case "tsx":
      return "typescript";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return "text";
  }
}

export function getCitationHash(input: { path: string; startLine?: number; endLine?: number }): string {
  return createHash("sha256")
    .update(`${input.path}:${input.startLine ?? ""}:${input.endLine ?? ""}`)
    .digest("hex");
}

export function isUsefulSourcePath(path: string): boolean {
  if (
    path.includes("node_modules/") ||
    path.includes("/dist/") ||
    path.includes("/build/") ||
    path.includes("/coverage/") ||
    path.endsWith(".lock")
  ) {
    return false;
  }

  const basename = path.split("/").at(-1)?.toLowerCase();
  if (basename !== undefined && ["readme", "license", "copying", "changelog", "dockerfile"].includes(basename)) {
    return true;
  }

  return /\.(ts|tsx|js|jsx|py|go|rs|md|mdx|json|yaml|yml|toml|css)$/i.test(path);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fetchGitHubRepoMetadata(repo: GitHubRepoRef): Promise<{
  commitSha: string;
  defaultBranch: string;
  description?: string;
  homepageUrl?: string;
  topics: string[];
}> {
  const metadata = await fetchGitHubJson<{
    default_branch?: string;
    description?: string | null;
    homepage?: string | null;
    private?: unknown;
    topics?: string[];
  }>(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}`,
  );
  assertPublicGitHubRepository(metadata);
  const defaultBranch = metadata.default_branch ?? "main";
  const branch = await fetchGitHubJson<{ commit?: { sha?: string } }>(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/branches/${defaultBranch}`,
  );
  const commitSha = branch.commit?.sha;

  if (commitSha === undefined) {
    throw new Error(`Could not resolve ${repo.owner}/${repo.repo} default branch commit.`);
  }

  return {
    commitSha,
    defaultBranch,
    description: metadata.description ?? undefined,
    homepageUrl: normalizeOptionalUrl(metadata.homepage),
    topics: metadata.topics ?? [],
  };
}

async function fetchGitHubJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`GitHub request failed before receiving a response (${url}): ${formatErrorMessage(error)}`);
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        `GitHub request was rate-limited or forbidden (${url}). Set GITHUB_TOKEN for reliable repository indexing.`,
      );
    }

    throw new Error(`GitHub request failed (${response.status}): ${url}`);
  }

  return (await response.json()) as T;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "openwiki",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token !== undefined && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function assertPublicGitHubRepository(metadata: { private?: unknown }) {
  if (metadata.private === true) {
    throw new Error("OpenWiki only supports public GitHub repositories.");
  }
}

function normalizeOptionalUrl(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value.trim().length === 0) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}
