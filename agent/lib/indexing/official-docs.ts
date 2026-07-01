import type { PreparedRepositoryWorkspace } from "../github-repo.js";
import { isInternalPlanningDocumentationPath } from "./source-paths.js";
import type { ContextSnippet } from "./types.js";

const MAX_CONTEXT_URLS = 40;
const MAX_DOCS_INDEX_CHARS = 32_000;
const MAX_FETCH_BYTES = 10_000_000;
const MAX_SITEMAP_DOC_LINKS = 600;
const MAX_HTML_HEADING_LINKS = 600;
const MAX_REPOSITORY_FALLBACK_FILES = 80;
const MAX_REPOSITORY_FALLBACK_SECTIONS = 400;
const MAX_REPOSITORY_FALLBACK_SECTIONS_PER_FILE = 16;
const MAX_REPOSITORY_FALLBACK_SOURCE_MAP_FILES = 48;
const MAX_OFFICIAL_DOCS_ENTRIES = 1_000;
const MAX_OFFICIAL_DOCS_PAGE_SNIPPETS = 4;
const MAX_OFFICIAL_DOCS_SNIPPET_CHARS = 5_000;
const OFFICIAL_DOCS_PAGE_TIMEOUT_MS = 5_000;
const DOCS_INDEX_TIMEOUT_MS = 7_000;
const DOCS_INDEX_FETCH_CONCURRENCY = 8;
const BLOCKED_DOCS_HOSTS = new Set([
  "azure.microsoft.com",
  "github.com",
  "issues.apache.org",
  "openai.com",
  "openwiki.sh",
  "raw.githubusercontent.com",
]);
const BLOCKED_DOCS_HOST_SUFFIXES = [
  "github.com",
  "npmjs.com",
  "pypi.org",
  "slack.com",
  "stackoverflow.com",
  "twitter.com",
  "wikipedia.org",
  "x.com",
  "youtube.com",
];
const BLOCKED_DOCS_HOST_SUBSTRINGS = [
  "badgen.net",
  "bugsplat.com",
  "discord.",
  "shields.io",
];
const HOSTED_DASHBOARD_OR_PREVIEW_HOSTS = [
  "cloudfront.net",
  "grafana.net",
  "herokuapp.com",
  "labs.vercel.dev",
];

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gi;
const LANGUAGE_SPECIFIC_LLMS_INDEX_PATTERN = /\/llms\/(?:js|javascript|ts|typescript|python|py|dart|swift|kotlin|java|csharp|cs|go|ruby|php|rust)\.txt$/i;
const officialDocsSnippetCache = new Map<string, Promise<ContextSnippet | undefined>>();

type OfficialDocsCandidate = {
  discoveredFrom: string;
  score: number;
  snapshot: PreparedRepositoryWorkspace;
  sourceUrl: string;
};

type OfficialDocsBody = {
  headingCount: number;
  linkCount: number;
  sourceUrl: string;
  text: string;
};

export type OfficialDocsEntry = {
  group?: string;
  title: string;
  url: string;
};

export type OfficialDocsIndex = {
  candidateScore: number;
  discoveredFrom: string;
  entries: OfficialDocsEntry[];
  excerpt: string;
  headingCount: number;
  linkCount: number;
  relevanceScore: number;
  sourceUrl: string;
};

export async function discoverOfficialDocsIndex(input: {
  contextSnippets: ContextSnippet[];
  snapshot: PreparedRepositoryWorkspace;
}): Promise<OfficialDocsIndex | undefined> {
  const candidates = createDocsIndexCandidates(input);
  const primaryCandidates = candidates.filter(isPrimaryDocsIndexCandidate);
  const primaryIndexes = await mapWithConcurrency(
    primaryCandidates,
    DOCS_INDEX_FETCH_CONCURRENCY,
    fetchOfficialDocsIndex,
  );
  const primaryIndex = selectBestDocsIndex(primaryIndexes);

  if (primaryIndex !== undefined && isStrongDocsIndex(primaryIndex)) {
    return primaryIndex;
  }

  const fallbackIndexes = await mapWithConcurrency(
    candidates.filter((candidate) => !isPrimaryDocsIndexCandidate(candidate)),
    DOCS_INDEX_FETCH_CONCURRENCY,
    fetchOfficialDocsIndex,
  );
  const fallbackIndex = selectBestDocsIndex([...primaryIndexes, ...fallbackIndexes]);
  if (fallbackIndex !== undefined) {
    if (isStrongDocsIndex(fallbackIndex)) return fallbackIndex;

    const repositoryFallbackIndex = await createGitHubDocsRepositoryFallbackIndex(input.snapshot);
    if (
      repositoryFallbackIndex !== undefined &&
      isBetterRepositoryFallbackIndex(repositoryFallbackIndex, fallbackIndex)
    ) {
      return repositoryFallbackIndex;
    }

    return fallbackIndex;
  }

  return createGitHubDocsRepositoryFallbackIndex(input.snapshot);
}

function selectBestDocsIndex(discovered: Array<OfficialDocsIndex | undefined>): OfficialDocsIndex | undefined {
  return discovered
    .filter((index): index is OfficialDocsIndex => index !== undefined)
    .sort((a, b) => scoreOfficialDocsIndex(b) - scoreOfficialDocsIndex(a))
    .at(0);
}

function isPrimaryDocsIndexCandidate(candidate: OfficialDocsCandidate): boolean {
  return /\.(txt|xml)$/i.test(new URL(candidate.sourceUrl).pathname);
}

function isStrongDocsIndex(index: OfficialDocsIndex): boolean {
  if (index.linkCount >= 220) return true;
  if (/llms.*\.txt$/i.test(index.sourceUrl) && index.linkCount >= 120) return true;
  if (/sitemap.*\.xml$/i.test(index.sourceUrl) && index.linkCount >= 40) return true;
  return index.headingCount >= 20 && index.linkCount >= 20;
}

function isBetterRepositoryFallbackIndex(
  repositoryFallbackIndex: OfficialDocsIndex,
  discoveredIndex: OfficialDocsIndex,
): boolean {
  if (!/^https:\/\/github\.com\//i.test(repositoryFallbackIndex.sourceUrl)) return false;
  if (
    discoveredIndex.linkCount < 20 &&
    discoveredIndex.headingCount < 20 &&
    repositoryFallbackIndex.linkCount >= Math.max(12, discoveredIndex.linkCount + 4)
  ) {
    return true;
  }
  if (repositoryFallbackIndex.linkCount < 20 && repositoryFallbackIndex.headingCount < 20) return false;
  if (repositoryFallbackIndex.linkCount >= discoveredIndex.linkCount * 2) return true;
  return repositoryFallbackIndex.headingCount >= discoveredIndex.headingCount * 2 && repositoryFallbackIndex.linkCount > discoveredIndex.linkCount;
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index] as T);
      }
    }),
  );

  return results;
}

export function formatOfficialDocsIndexForPrompt(index: OfficialDocsIndex | undefined): string {
  if (index === undefined) {
    return "- No external first-party docs index was discovered from repository metadata or context links.";
  }

  const coverageGroups = formatOfficialDocsCoverageGroups(index.entries);
  return [
    `Source: ${index.sourceUrl}`,
    `Discovered from: ${index.discoveredFrom}`,
    `Entries: ${index.linkCount} linked docs pages, ${index.headingCount} headings`,
    "Use this as information-architecture evidence for page selection and sidebar structure. Generated pages must still ground concrete claims in repository source paths.",
    "",
    "High-volume official docs groups to preserve:",
    coverageGroups.length === 0 ? "- No stable groups were extracted." : coverageGroups,
    "",
    index.excerpt,
  ].join("\n");
}

export async function readOfficialDocsPageSnippets(input: {
  officialDocsIndex?: OfficialDocsIndex;
  page: {
    purpose: string;
    slug: string;
    title: string;
  };
}): Promise<ContextSnippet[]> {
  if (input.officialDocsIndex === undefined || input.officialDocsIndex.entries.length === 0) {
    return [];
  }

  const entries = selectOfficialDocsEntriesForPage({
    entries: input.officialDocsIndex.entries,
    page: input.page,
  });
  const snippets = await Promise.all(entries.map(readOfficialDocsEntrySnippet));
  return snippets.filter((snippet): snippet is ContextSnippet => snippet !== undefined);
}

function createDocsIndexCandidates(input: {
  contextSnippets: ContextSnippet[];
  snapshot: PreparedRepositoryWorkspace;
}): OfficialDocsCandidate[] {
  const urls = new Set<string>();
  for (const url of getKnownOfficialDocsSeedUrls(input.snapshot)) {
    if (isAllowedDocsUrl(url)) urls.add(url);
  }
  if (input.snapshot.homepageUrl !== undefined) {
    const homepageUrl = cleanUrl(input.snapshot.homepageUrl);
    if (homepageUrl !== undefined && isAllowedDocsUrl(homepageUrl)) {
      urls.add(homepageUrl);
    }
  }

  for (const snippet of input.contextSnippets) {
    for (const match of snippet.text.matchAll(URL_PATTERN)) {
      const cleaned = cleanUrl(match[0]);
      if (cleaned !== undefined && isLikelyProjectDocsUrl(cleaned, input.snapshot)) {
        urls.add(cleaned);
      }
    }
  }

  const candidates = new Map<string, OfficialDocsCandidate>();
  for (const rawUrl of [...urls].slice(0, MAX_CONTEXT_URLS)) {
    for (const sourceUrl of getLikelyDocsIndexUrls(rawUrl, input.snapshot)) {
      const score = scoreCandidateUrl(rawUrl, sourceUrl, input.snapshot);
      const previous = candidates.get(sourceUrl);
      if (previous === undefined || score > previous.score) {
        candidates.set(sourceUrl, {
          discoveredFrom: rawUrl,
          score,
          snapshot: input.snapshot,
          sourceUrl,
        });
      }
    }
  }

  return limitCandidatesPerOrigin([...candidates.values()]
    .sort((a, b) => b.score - a.score || getCandidatePathLength(a) - getCandidatePathLength(b))
    .slice(0, 120));
}

function getCandidatePathLength(candidate: OfficialDocsCandidate): number {
  try {
    return new URL(candidate.sourceUrl).pathname.length;
  } catch {
    return candidate.sourceUrl.length;
  }
}

function limitCandidatesPerOrigin(candidates: OfficialDocsCandidate[]): OfficialDocsCandidate[] {
  const counts = new Map<string, number>();
  const primaryCounts = new Map<string, number>();
  const limited: OfficialDocsCandidate[] = [];

  for (const candidate of candidates) {
    const origin = new URL(candidate.sourceUrl).origin;
    const maxForOrigin = /\/\/learn\.microsoft\.com$/i.test(origin) ? 8 : 28;
    const maxPrimaryForOrigin = /\/\/learn\.microsoft\.com$/i.test(origin) ? 5 : 18;
    const count = counts.get(origin) ?? 0;
    if (count >= maxForOrigin) continue;
    if (isPrimaryDocsIndexCandidate(candidate)) {
      const primaryCount = primaryCounts.get(origin) ?? 0;
      if (primaryCount >= maxPrimaryForOrigin) continue;
      primaryCounts.set(origin, primaryCount + 1);
    }
    counts.set(origin, count + 1);
    limited.push(candidate);
  }

  return limited.slice(0, 100);
}

async function fetchOfficialDocsIndex(
  candidate: OfficialDocsCandidate,
): Promise<OfficialDocsIndex | undefined> {
  const response = await fetchText(candidate.sourceUrl, {
    accept: "text/html, text/plain, text/markdown, application/xml, text/xml, */*;q=0.5",
  });
  if (response === undefined) return undefined;
  if (!isAllowedDocsUrl(response.sourceUrl)) return undefined;

  const resolvedCandidate = {
    ...candidate,
    sourceUrl: response.sourceUrl,
  };
  const body = await createOfficialDocsBody(resolvedCandidate, response.text);
  if (body === undefined) return undefined;
  if (isNonDocumentationPagePath(new URL(body.sourceUrl).pathname.toLowerCase())) return undefined;

  const relevanceScore = scoreDocsIndexRelevance({
    candidate: resolvedCandidate,
    text: body.text,
  });
  if (relevanceScore < 4) return undefined;
  if (isWeakBroadSitemapFallback({
    body,
    candidate: resolvedCandidate,
    relevanceScore,
  })) return undefined;
  if (isWeakBroadTextIndexFallback({
    body,
    candidate: resolvedCandidate,
    relevanceScore,
  })) return undefined;

  const extractedEntries = extractOfficialDocsEntries(body.text, body.sourceUrl);
  if (isTinyNonDocumentationSitemapIndex({
    body,
    entries: extractedEntries,
  })) {
    return undefined;
  }
  const sourceScopedEntries = filterOfficialDocsEntriesForSource(body.sourceUrl, extractedEntries);
  const entries = filterOfficialDocsEntriesForRepository(sourceScopedEntries, resolvedCandidate.snapshot);
  const promptText = entries.length < extractedEntries.length
    ? formatOfficialDocsEntriesIndex(body.sourceUrl, entries)
    : body.text;
  const promptHeadingCount = entries.length < extractedEntries.length
    ? countMarkdownHeadings(promptText)
    : body.headingCount;
  const promptLinkCount = entries.length < extractedEntries.length
    ? entries.length
    : body.linkCount;

  return {
    candidateScore: candidate.score,
    discoveredFrom: candidate.discoveredFrom,
    entries,
    excerpt: prettifyDocsIndex(promptText).slice(0, MAX_DOCS_INDEX_CHARS),
    headingCount: promptHeadingCount,
    linkCount: promptLinkCount,
    relevanceScore,
    sourceUrl: body.sourceUrl,
  };
}

function isTinyNonDocumentationSitemapIndex(input: {
  body: OfficialDocsBody;
  entries: OfficialDocsEntry[];
}): boolean {
  let source: URL;
  try {
    source = new URL(input.body.sourceUrl);
  } catch {
    return false;
  }

  if (source.pathname.toLowerCase() !== "/sitemap.xml") return false;
  if (isDocsHost(source)) return false;
  if (input.body.linkCount >= 30 || input.entries.length >= 30) return false;

  const docsShapedEntries = input.entries.filter((entry) => {
    let pathname = "";
    try {
      pathname = new URL(entry.url).pathname;
    } catch {
      pathname = entry.url;
    }
    const text = `${entry.group ?? ""} ${entry.title} ${pathname}`.toLowerCase();
    return /(?:^|[\\s/-])(?:docs?|documentation|learn|guide|guides|api|reference|manual|tutorial|tutorials|examples?|cookbook|runtime|deploy|cli|sdk|framework|fundamentals|concepts|components|commands|configuration|extensions?|quickstart|install|installation|auth|authentication)(?:$|[\\s/-])/.test(text);
  });

  return docsShapedEntries.length < 3;
}

function isWeakBroadSitemapFallback(input: {
  body: OfficialDocsBody;
  candidate: OfficialDocsCandidate;
  relevanceScore: number;
}): boolean {
  let source: URL;
  let discoveredFrom: URL;
  try {
    source = new URL(input.body.sourceUrl);
    discoveredFrom = new URL(input.candidate.discoveredFrom);
  } catch {
    return false;
  }

  if (source.pathname.toLowerCase() !== "/sitemap.xml") return false;
  if (isRepoSpecificHostOrPath(source, input.candidate.snapshot)) return false;
  if (!isRepoSpecificHostOrPath(discoveredFrom, input.candidate.snapshot)) return false;

  return input.relevanceScore < 10 || input.body.linkCount < 120;
}

function isWeakBroadTextIndexFallback(input: {
  body: OfficialDocsBody;
  candidate: OfficialDocsCandidate;
  relevanceScore: number;
}): boolean {
  let source: URL;
  let discoveredFrom: URL;
  try {
    source = new URL(input.body.sourceUrl);
    discoveredFrom = new URL(input.candidate.discoveredFrom);
  } catch {
    return false;
  }

  if (!/^\/llms(?:-full)?\.txt$/i.test(source.pathname)) return false;
  if (source.origin !== discoveredFrom.origin) return false;

  const discoveredPathSegments = getPathSegments(discoveredFrom);
  if (discoveredPathSegments.length < 2) return false;

  const discoveredFromRepoPath = isRepoSpecificHostOrPath(discoveredFrom, input.candidate.snapshot);
  const weakAllProductIndex = input.body.linkCount >= 500 && input.relevanceScore <= 10;
  return discoveredFromRepoPath || weakAllProductIndex;
}

async function readOfficialDocsEntrySnippet(entry: OfficialDocsEntry): Promise<ContextSnippet | undefined> {
  const cached = officialDocsSnippetCache.get(entry.url);
  if (cached !== undefined) return cached;
  if (officialDocsSnippetCache.size > 500) officialDocsSnippetCache.clear();

  const pending = readOfficialDocsEntrySnippetUncached(entry);
  officialDocsSnippetCache.set(entry.url, pending);
  return pending;
}

async function readOfficialDocsEntrySnippetUncached(entry: OfficialDocsEntry): Promise<ContextSnippet | undefined> {
  const contentUrl = toFetchableOfficialDocsUrl(entry.url);
  const response = await fetchTextWithTimeout(contentUrl, {
    accept: "text/html, text/plain, text/markdown, */*;q=0.5",
    timeoutMs: OFFICIAL_DOCS_PAGE_TIMEOUT_MS,
  });
  if (response === undefined) return undefined;

  const bodyText = isLikelyHtml(response.text)
    ? extractReadableHtmlText(response.text, entry)
    : prettifyDocsIndex(response.text);
  const text = [
    `Official docs page: ${entry.title}`,
    entry.group === undefined ? undefined : `Section: ${entry.group}`,
    `URL: ${entry.url}`,
    "",
    bodyText.slice(0, MAX_OFFICIAL_DOCS_SNIPPET_CHARS).trim(),
  ].filter((line): line is string => line !== undefined).join("\n");
  if (text.trim().length < 200) return undefined;

  return {
    path: `official-docs:${entry.url}`,
    text,
  };
}

function toFetchableOfficialDocsUrl(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname === "github.com") {
      const parts = getPathSegments(url);
      if (parts.length >= 5 && parts[2] === "blob") {
        const [owner, repo,, branch, ...pathParts] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathParts.join("/")}`;
      }
    }
  } catch {
    return sourceUrl;
  }

  return sourceUrl;
}

function fetchTextWithTimeout(
  sourceUrl: string,
  options: {
    accept: string;
    timeoutMs: number;
  },
): Promise<{ sourceUrl: string; text: string } | undefined> {
  return fetchText(sourceUrl, {
    accept: options.accept,
    timeoutMs: options.timeoutMs,
  });
}

async function fetchText(
  sourceUrl: string,
  options: {
    accept: string;
    timeoutMs?: number;
  },
): Promise<{ sourceUrl: string; text: string } | undefined> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(sourceUrl, {
        headers: {
          accept: options.accept,
          "user-agent": "openwiki-docs-indexer",
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? DOCS_INDEX_TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }

    if (response.ok) break;
    if (!isRetriableDocsResponse(response) || attempt === 2) return undefined;
    await delay(getDocsRetryDelayMs(response, attempt));
  }

  if (response === undefined || !response.ok) return undefined;

  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > MAX_FETCH_BYTES) return undefined;

  const text = await response.text();
  if (text.length === 0 || text.length > MAX_FETCH_BYTES) return undefined;
  return { sourceUrl: response.url || sourceUrl, text };
}

function isRetriableDocsResponse(response: Response): boolean {
  return response.status === 429 || response.status === 503;
}

function getDocsRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(5_000, seconds * 1_000);
    }

    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.min(5_000, Math.max(0, timestamp - Date.now()));
    }
  }

  return 750 * (attempt + 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function createGitHubDocsRepositoryFallbackIndex(
  snapshot: PreparedRepositoryWorkspace,
): Promise<OfficialDocsIndex | undefined> {
  if (snapshot.owner.toLowerCase() === "dotnet" && snapshot.repo.toLowerCase() === "runtime") {
    const docsTree = await fetchGitHubTree("dotnet", "docs", "main");
    if (docsTree !== undefined) {
      const docsPaths = docsTree
        .filter((entry) =>
          entry.type === "blob" &&
          /\.(md|mdx)$/i.test(entry.path) &&
          /^docs\/(core|fundamentals|standard)\//i.test(entry.path),
        )
        .map((entry) => entry.path)
        .sort(compareDocumentationPathsForFallback);

      if (docsPaths.length >= 30) {
        const text = formatGitHubDocsRepositoryIndex({
          branch: "main",
          docsFiles: [],
          docsPaths,
          owner: "dotnet",
          repo: "docs",
          sourceMapPaths: [],
          sourceUrl: "https://github.com/dotnet/docs/tree/main/docs",
        });

        return {
          candidateScore: 0,
          discoveredFrom: "https://github.com/dotnet/docs",
          entries: extractOfficialDocsEntries(text, "https://github.com/dotnet/docs/tree/main/docs"),
          excerpt: text.slice(0, MAX_DOCS_INDEX_CHARS),
          headingCount: countMarkdownHeadings(text),
          linkCount: docsPaths.length,
          relevanceScore: 8,
          sourceUrl: "https://github.com/dotnet/docs/tree/main/docs",
        };
      }
    }
  }

  return createCurrentRepositoryDocsFallbackIndex(snapshot);
}

async function createCurrentRepositoryDocsFallbackIndex(
  snapshot: PreparedRepositoryWorkspace,
): Promise<OfficialDocsIndex | undefined> {
  const primaryDocsPaths = snapshot.fileInventory
    .filter((file) => isRepositoryDocumentationSourcePath(file.path))
    .map((file) => file.path)
    .sort(compareDocumentationPathsForFallback);
  const docsPaths = primaryDocsPaths.length >= 5
    ? primaryDocsPaths
    : dedupeStrings([
        ...primaryDocsPaths,
        ...snapshot.fileInventory
          .filter((file) => isRepositoryGuideReadmePath(file.path))
          .map((file) => file.path),
      ]).sort(compareDocumentationPathsForFallback);

  if (docsPaths.length < 2 && !hasRootReadmeOnlyFallback(snapshot, docsPaths)) return undefined;

  const sourceUrl = `https://github.com/${snapshot.owner}/${snapshot.repo}/tree/${snapshot.defaultBranch}`;
  const docsFiles = await readRepositoryDocsFallbackFiles(snapshot, docsPaths);
  const sourceMapPaths = shouldIncludeRepositoryFallbackSourceMap(docsFiles)
    ? selectRepositoryFallbackSourceMapPaths(snapshot, docsPaths)
    : [];
  const text = formatGitHubDocsRepositoryIndex({
    branch: snapshot.defaultBranch,
    docsFiles,
    docsPaths,
    owner: snapshot.owner,
    repo: snapshot.repo,
    sourceMapPaths,
    sourceUrl,
  });
  const entries = extractOfficialDocsEntries(text, sourceUrl);

  return {
    candidateScore: 0,
    discoveredFrom: snapshot.url,
    entries,
    excerpt: text.slice(0, MAX_DOCS_INDEX_CHARS),
    headingCount: countMarkdownHeadings(text),
    linkCount: Math.max(docsPaths.length, entries.length),
    relevanceScore: 8,
    sourceUrl,
  };
}

type RepositoryDocsFallbackFile = {
  headings: Array<{
    anchor: string;
    level: number;
    title: string;
  }>;
  path: string;
};

async function readRepositoryDocsFallbackFiles(
  snapshot: PreparedRepositoryWorkspace,
  docsPaths: string[],
): Promise<RepositoryDocsFallbackFile[]> {
  const docsFiles = await mapWithConcurrency(
    docsPaths.slice(0, MAX_REPOSITORY_FALLBACK_FILES),
    4,
    async (path): Promise<RepositoryDocsFallbackFile> => {
      let text = "";
      try {
        text = await readGitHubRepositoryTextFile(snapshot, path) ?? "";
      } catch {
        // Keep the file-level fallback when a raw file cannot be read.
      }

      return {
        headings: extractRepositoryMarkdownHeadings(text, path),
        path,
      };
    },
  );

  return docsFiles;
}

function isRepositoryDocumentationSourcePath(path: string): boolean {
  if (isInternalPlanningDocumentationPath(path)) return false;

  const normalized = path.toLowerCase();
  if (!isUsableRepositoryMarkdownPath(normalized)) return false;
  if (/^translations\/(?!en\/)[a-z]{2}(?:-[a-z]{2})?\//i.test(normalized)) return false;
  return (
    /(^|\/)(docs?|documentation|developer-docs|content|website|site)(\/|$)/i.test(normalized) ||
    /^apps\/docs\//i.test(normalized) ||
    /^apps\/(?:web|www)\/docs\//i.test(normalized) ||
    /^apps\/(?:web|www)\/src\/(?:app|pages)\/docs\//i.test(normalized) ||
    /^packages\/(?:docs|documentation)\//i.test(normalized) ||
    /^\d{2,3}-[a-z0-9-]+\/readme\.(md|mdx|rst)$/i.test(normalized) ||
    /^translations\/en\/\d{2,3}-[a-z0-9-]+\/readme\.(md|mdx|rst)$/i.test(normalized)
  );
}

function isRepositoryGuideReadmePath(path: string): boolean {
  if (isInternalPlanningDocumentationPath(path)) return false;

  const normalized = path.toLowerCase();
  if (!isUsableRepositoryMarkdownPath(normalized)) return false;
  if (!/(^|\/)(?:readme|index)\.(md|mdx|rst)$/i.test(normalized)) return false;
  if (/^(?:dist|build|coverage|vendor|node_modules|test|tests|__tests__|fixtures?|examples?\/fixture)/i.test(normalized)) {
    return false;
  }
  if (/^\.changeset\//i.test(normalized)) return false;
  return (
    /^(?:readme|index)\.(md|mdx|rst)$/i.test(normalized) ||
    /^(?:examples?|samples?|templates?|demo|demos|evaluation|eval|evals|finetune|data|packages?|apps?|tools?|cli)\//i.test(normalized)
  );
}

function isUsableRepositoryMarkdownPath(normalizedPath: string): boolean {
  if (!/\.(md|mdx|rst)$/i.test(normalizedPath)) return false;
  if (/(^|\/)(?:_navbar|_sidebar|navbar|sidebar|enhanced_features_roadmap|security_guidelines)\.(md|mdx|rst)$/i.test(normalizedPath)) {
    return false;
  }
  if (/(^|\/)(?:404|not-found)\.(md|mdx|rst)$/i.test(normalizedPath)) return false;
  if (/(^|\/)(?:license|code_of_conduct|security|contributing|changelog|changes)\.(md|mdx|rst)$/i.test(normalizedPath)) {
    return false;
  }
  if (/\/(?:blog|posts|news|changelog|changesets?|release-notes?|licenses?)\//i.test(normalizedPath)) return false;
  return true;
}

function hasRootReadmeOnlyFallback(
  snapshot: PreparedRepositoryWorkspace,
  docsPaths: string[],
): boolean {
  if (docsPaths.length !== 1 || !/^readme\.(md|mdx|rst)$/i.test(docsPaths[0] ?? "")) return false;
  return snapshot.fileInventory.length <= 400;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function readGitHubRepositoryTextFile(
  snapshot: PreparedRepositoryWorkspace,
  path: string,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(
      `https://raw.githubusercontent.com/${snapshot.owner}/${snapshot.repo}/${snapshot.commitSha}/${path}`,
      {
        headers: {
          ...githubApiHeaders(),
          accept: "text/plain, text/markdown, */*;q=0.5",
        },
        signal: AbortSignal.timeout(DOCS_INDEX_TIMEOUT_MS),
      },
    );
  } catch {
    return undefined;
  }

  if (!response.ok) return undefined;
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > MAX_FETCH_BYTES) return undefined;

  const text = await response.text();
  if (text.length === 0 || text.length > MAX_FETCH_BYTES) return undefined;
  return text;
}

async function fetchGitHubTree(
  owner: string,
  repo: string,
  branch: string,
): Promise<Array<{ path: string; type: string }> | undefined> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
      headers: githubApiHeaders(),
      signal: AbortSignal.timeout(DOCS_INDEX_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const body = await response.json() as {
    tree?: Array<{ path?: string; type?: string }>;
  };
  return body.tree
    ?.filter((entry): entry is { path: string; type: string } =>
      typeof entry.path === "string" && typeof entry.type === "string",
    );
}

function githubApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "openwiki-docs-indexer",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token !== undefined && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function compareDocumentationPathsForFallback(a: string, b: string): number {
  return getDocumentationPathSortKey(a).localeCompare(getDocumentationPathSortKey(b));
}

function getDocumentationPathSortKey(path: string): string {
  if (/\/(get-started|getting-started|quickstart|tutorial|overview|introduction|index)\.mdx?$/i.test(path)) {
    return `0:${path}`;
  }
  if (/\/(fundamentals|core)\//i.test(path)) return `1:${path}`;
  if (/\/(standard|api|reference)\//i.test(path)) return `2:${path}`;
  return `3:${path}`;
}

function formatGitHubDocsRepositoryIndex(input: {
  branch: string;
  docsFiles: RepositoryDocsFallbackFile[];
  docsPaths: string[];
  owner: string;
  repo: string;
  sourceMapPaths: string[];
  sourceUrl: string;
}): string {
  const docsFilesByPath = new Map(input.docsFiles.map((file) => [file.path, file]));
  const groups = new Map<string, RepositoryDocsFallbackFile[]>();
  for (const path of input.docsPaths.slice(0, MAX_SITEMAP_DOC_LINKS)) {
    const group = getDocsRepositoryPathGroup(path);
    groups.set(group, [...(groups.get(group) ?? []), docsFilesByPath.get(path) ?? { headings: [], path }]);
  }

  const lines = [
    "# First-party Documentation Source Tree",
    "",
    `The public documentation site was unavailable, so OpenWiki used the first-party ${input.owner}/${input.repo} documentation source tree at ${input.sourceUrl}.`,
  ];

  for (const [group, paths] of groups) {
    lines.push("", `## ${group}`);
    for (const file of paths) {
      const fileUrl = docsRepositoryPathToPublicUrl(file.path, input);
      lines.push(`- [${titleFromDocsRepositoryPath(file.path)}](${fileUrl})`);
      for (const heading of file.headings) {
        lines.push(`  - [${heading.title}](${fileUrl}#${heading.anchor})`);
      }
    }
  }

  if (input.sourceMapPaths.length > 0) {
    lines.push("", "## Source Map");
    for (const path of input.sourceMapPaths) {
      lines.push(`- [${titleFromRepositorySourcePath(path)}](${docsRepositoryPathToPublicUrl(path, input)})`);
    }
  }

  return lines.join("\n");
}

function shouldIncludeRepositoryFallbackSourceMap(files: RepositoryDocsFallbackFile[]): boolean {
  const linkCount = files.reduce((total, file) => total + 1 + file.headings.length, 0);
  return linkCount < 20;
}

function selectRepositoryFallbackSourceMapPaths(
  snapshot: PreparedRepositoryWorkspace,
  docsPaths: string[],
): string[] {
  const excludedPaths = new Set(docsPaths.map((path) => path.toLowerCase()));
  return snapshot.fileInventory
    .filter((file) => !excludedPaths.has(file.path.toLowerCase()))
    .filter((file) => isRepositoryFallbackSourceMapPath(file.path))
    .sort((a, b) =>
      scoreRepositoryFallbackSourceMapPath(b.path) - scoreRepositoryFallbackSourceMapPath(a.path) ||
      a.path.localeCompare(b.path)
    )
    .slice(0, MAX_REPOSITORY_FALLBACK_SOURCE_MAP_FILES)
    .map((file) => file.path);
}

function isRepositoryFallbackSourceMapPath(path: string): boolean {
  const normalized = path.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|ico|lock|log|map|snap|wasm|woff2?|ttf|otf)$/i.test(normalized)) return false;
  if (/(^|\/)(?:dist|build|coverage|vendor|node_modules|test-results|fixtures?)(\/|$)/i.test(normalized)) {
    return false;
  }
  if (/^(?:package\.json|pnpm-workspace\.yaml|turbo\.json|vercel\.json|next\.config\.(?:js|mjs|ts)|tsconfig\.json)$/i.test(normalized)) {
    return true;
  }
  if (/(^|\/)(?:package\.json|next\.config\.(?:js|mjs|ts)|vercel\.json|tsconfig\.json)$/i.test(normalized)) {
    return true;
  }
  if (/^(?:app|pages|src|lib|components|server|client|cli|commands|api|packages|examples?)\//i.test(normalized)) {
    return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|kt|java|cs|json|yaml|yml)$/i.test(normalized);
  }
  if (/(^|\/)(?:app|pages|src|lib|components|server|client|cli|commands|api)\//i.test(normalized)) {
    return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|kt|java|cs|json|yaml|yml)$/i.test(normalized);
  }
  return false;
}

function scoreRepositoryFallbackSourceMapPath(path: string): number {
  const normalized = path.toLowerCase();
  let score = 0;
  if (/^(?:package\.json|pnpm-workspace\.yaml|turbo\.json|vercel\.json|next\.config\.(?:js|mjs|ts)|tsconfig\.json)$/i.test(normalized)) {
    score += 100;
  }
  if (/(^|\/)(?:package\.json|next\.config\.(?:js|mjs|ts)|vercel\.json|tsconfig\.json)$/i.test(normalized)) {
    score += 70;
  }
  if (/(^|\/)(?:index|main|cli|server|client|config|route|page|layout|middleware)\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(normalized)) {
    score += 90;
  }
  if (/^(?:app|pages)\/(?:api\/)?/i.test(normalized)) score += 80;
  if (/(^|\/)(?:app|pages)\/(?:api\/)?/i.test(normalized)) score += 70;
  if (/^(?:src|lib|server|client|cli|commands|api)\//i.test(normalized)) score += 65;
  if (/(^|\/)(?:src|lib|server|client|cli|commands|api)\//i.test(normalized)) score += 55;
  if (/^packages?\//i.test(normalized)) score += 45;
  if (/^examples?\//i.test(normalized)) score += 25;
  score -= Math.min(40, normalized.split("/").length * 4);
  return score;
}

function titleFromRepositorySourcePath(path: string): string {
  return path;
}

function extractRepositoryMarkdownHeadings(
  text: string,
  path: string,
): RepositoryDocsFallbackFile["headings"] {
  if (text.length === 0) return [];

  const headings: Array<{ level: number; title: string }> = [];
  const lines = text.split(/\r?\n/);
  let inCodeFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trimEnd() ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const markdownHeading = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (markdownHeading !== null) {
      const level = markdownHeading[1]?.length ?? 2;
      const title = cleanRepositoryFallbackHeading(markdownHeading[2] ?? "");
      if (shouldKeepRepositoryFallbackHeading({ level, path, title })) {
        headings.push({ level, title });
      }
      continue;
    }

    const nextLine = lines[index + 1]?.trim() ?? "";
    const rstHeadingLevel = getRstHeadingLevel(nextLine);
    if (rstHeadingLevel !== undefined) {
      const title = cleanRepositoryFallbackHeading(line);
      if (shouldKeepRepositoryFallbackHeading({ level: rstHeadingLevel, path, title })) {
        headings.push({ level: rstHeadingLevel, title });
      }
      index += 1;
    }
  }

  return addRepositoryFallbackHeadingAnchors(headings)
    .slice(0, MAX_REPOSITORY_FALLBACK_SECTIONS_PER_FILE);
}

function cleanRepositoryFallbackHeading(title: string): string {
  return cleanDocsHeadingTitle(title
    .replace(/<[^>]+>/g, " ")
    .replace(/\{#[^}]+}/g, "")
    .replace(/[`*_~[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim());
}

function shouldKeepRepositoryFallbackHeading(input: {
  level: number;
  path: string;
  title: string;
}): boolean {
  if (input.title.length < 3) return false;
  const title = input.title.toLowerCase();
  const fileTitle = titleFromDocsRepositoryPath(input.path).toLowerCase();
  if (input.level === 1 && (title === fileTitle || title === "readme")) return false;
  if (input.title.length > 90) return false;
  if (isNoisyRepositoryFallbackHeading(input.title)) return false;
  if (/^(?:[$>]|(?:npm|pnpm|yarn|bun|npx|pip|python|node|cargo|go|docker|kubectl|curl|cd)\b)/i.test(input.title)) {
    return false;
  }
  if (/^(?:const|let|var|import|export|return|await|async|function|class|type|interface)\b/i.test(input.title)) {
    return false;
  }
  if (/[{};]|\s=>\s|=\w|={2,}/.test(input.title)) return false;
  if (/^(license|licenses|authors?|contributors?|acknowledgements?|thanks|sponsors?|support|badge|badges|status|copyright)$/i.test(input.title)) {
    return false;
  }
  return true;
}

function isNoisyRepositoryFallbackHeading(title: string): boolean {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");

  if (/^(?:table of contents|contents)$/i.test(normalized)) return true;
  if (/^(?:what to read next|where to go next|read next|next steps?|related(?: pages?| resources?| links?)?)$/i.test(normalized)) {
    return true;
  }
  return /^(?:previous|next|on this page|in this article|feedback|was this helpful|edit this page)$/i.test(normalized);
}

function getRstHeadingLevel(underline: string): number | undefined {
  if (!/^(=|-|~|`|#|\*)\1{2,}$/.test(underline)) return undefined;
  const marker = underline.charAt(0);
  if (marker === "=") return 1;
  if (marker === "-") return 2;
  return 3;
}

function addRepositoryFallbackHeadingAnchors(
  headings: Array<{ level: number; title: string }>,
): RepositoryDocsFallbackFile["headings"] {
  const seen = new Map<string, number>();
  return headings
    .slice(0, MAX_REPOSITORY_FALLBACK_SECTIONS)
    .map((heading) => {
      const baseAnchor = githubMarkdownHeadingAnchor(heading.title);
      const count = seen.get(baseAnchor) ?? 0;
      seen.set(baseAnchor, count + 1);
      return {
        anchor: count === 0 ? baseAnchor : `${baseAnchor}-${count}`,
        level: heading.level,
        title: heading.title,
      };
    });
}

function githubMarkdownHeadingAnchor(title: string): string {
  const anchor = title
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/&[a-z0-9#]+;/gi, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return anchor.length === 0 ? "section" : anchor;
}

function getDocsRepositoryPathGroup(path: string): string {
  const routeSegments = getDocsRouteSegments(path);
  if (routeSegments !== undefined) {
    return titleFromSlugPath(routeSegments.length === 0 ? ["overview"] : routeSegments.slice(0, 2));
  }

  const segments = path.split("/");
  const docsRootIndex = segments.findIndex((segment) =>
    /^(docs?|documentation|developer-docs|content|website|site)$/i.test(segment),
  );
  if (docsRootIndex >= 0) {
    return titleFromSlugPath([segments.at(docsRootIndex + 1), segments.at(docsRootIndex + 2)]);
  }
  return titleFromSlugPath([segments.at(0), segments.at(1)]);
}

function titleFromDocsRepositoryPath(path: string): string {
  const routeSegments = getDocsRouteSegments(path);
  if (routeSegments !== undefined) {
    return titleFromSlug(routeSegments.at(-1) ?? "overview");
  }

  const segments = path.split("/");
  const basename = segments.at(-1) ?? path;
  if (/^(readme|index)\.(md|mdx|rst)$/i.test(basename)) {
    return titleFromSlug(segments.at(-2) ?? basename.replace(/\.(md|mdx|rst)$/i, ""));
  }
  return titleFromSlug(basename.replace(/\.(md|mdx|rst)$/i, ""));
}

function getDocsRouteSegments(path: string): string[] | undefined {
  const segments = path.split("/");
  const srcIndex = segments.findIndex((segment, index) =>
    segment === "src" && segments.at(index + 1) === "app"
  );
  if (srcIndex < 0) return undefined;

  const basename = segments.at(-1) ?? "";
  if (!/^(page|index)\.(md|mdx|rst)$/i.test(basename)) return undefined;
  return segments
    .slice(srcIndex + 2, -1)
    .filter((segment) => !/^\(.+\)$/.test(segment));
}

function docsRepositoryPathToPublicUrl(
  path: string,
  repo: {
    branch: string;
    owner: string;
    repo: string;
  },
): string {
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${path}`;
}

async function createOfficialDocsBody(
  candidate: OfficialDocsCandidate,
  text: string,
): Promise<OfficialDocsBody | undefined> {
  if (isLikelySitemap(candidate.sourceUrl, text)) {
    return createSitemapDocsBody(candidate, text);
  }

  if (isLikelyHtml(text)) {
    return createHtmlDocsBody(candidate, text);
  }

  const expanded = await expandLinkedLlmsIndex(candidate, text);
  const bodyText = expanded?.text ?? text;
  const linkCount = countMarkdownLinks(bodyText);
  const headingCount = countMarkdownHeadings(bodyText);
  const sourceUrl = expanded?.sourceUrl ?? candidate.sourceUrl;
  const isDenseLlmsIndex = /\/llms(?:-full)?\.txt$/i.test(sourceUrl) && linkCount >= 60;
  const isTrustedCompactLlmsIndex =
    /\/llms(?:-full)?\.txt$/i.test(sourceUrl) &&
    linkCount >= 30 &&
    isAdjacentOfficialDocsSource(new URL(sourceUrl), candidate.snapshot);
  if (linkCount < 10 || (headingCount < 2 && !isDenseLlmsIndex && !isTrustedCompactLlmsIndex)) return undefined;

  return {
    headingCount,
    linkCount,
    sourceUrl,
    text: bodyText,
  };
}

async function expandLinkedLlmsIndex(
  candidate: OfficialDocsCandidate,
  text: string,
): Promise<{ sourceUrl: string; text: string } | undefined> {
  const currentLinkCount = countMarkdownLinks(text);
  const currentHeadingCount = countMarkdownHeadings(text);
  if (shouldPreserveCompactLlmsIndex(candidate.sourceUrl, text, currentLinkCount)) {
    return undefined;
  }
  const linkedIndexes = getLinkedLlmsTextUrls(text, candidate.sourceUrl)
    .sort((a, b) => scoreLinkedLlmsUrl(b) - scoreLinkedLlmsUrl(a));
  if (linkedIndexes.length === 0 || (currentLinkCount >= 30 && currentHeadingCount >= 4)) {
    return undefined;
  }

  const candidates: Array<{ sourceUrl: string; text: string }> = [];
  for (const sourceUrl of linkedIndexes.slice(0, 8)) {
    const response = await fetchText(sourceUrl, {
      accept: "text/plain, text/markdown, */*;q=0.5",
    });
    if (response !== undefined) {
      candidates.push({
        sourceUrl: response.sourceUrl,
        text: response.text,
      });
    }
  }

  return candidates
    .filter((entry) => countMarkdownLinks(entry.text) >= currentLinkCount)
    .sort((a, b) => scoreLinkedLlmsText(b) - scoreLinkedLlmsText(a))
    .at(0);
}

function shouldPreserveCompactLlmsIndex(sourceUrl: string, text: string, linkCount: number): boolean {
  let pathname: string;
  try {
    pathname = new URL(sourceUrl).pathname.toLowerCase();
  } catch {
    return false;
  }

  if (!pathname.endsWith("/llms.txt") && pathname !== "/llms.txt") return false;
  if (linkCount < 20) return false;

  const prologue = text.slice(0, 12_000);
  return (
    /(^|\n)#{1,3}\s+(documentation|docs|guides|reference|api reference|products?|build|manage|resources?)\b/i.test(prologue) ||
    /\/docs\/(?:guides|reference|api|resources|start|getting-started)\//i.test(prologue) ||
    /\/docs\/guides\/[a-z0-9-]+\.md/i.test(prologue)
  );
}

function scoreLinkedLlmsUrl(sourceUrl: string): number {
  const url = new URL(sourceUrl);
  const path = url.pathname.toLowerCase();
  let score = 0;
  if (/full/.test(path)) score += 120;
  if (/(latest|current|stable|5x|v5|en)(?:[./-]|$)/.test(path)) score += 40;
  if (/(api|reference|guide|guides|middleware|resource)/.test(path)) score += 20;
  if (/-(zh|ja|ko|fr|de|es|it|pt|ru|tr|ar)(?:[-.]|$)/.test(path)) score -= 40;
  return score;
}

function scoreLinkedLlmsText(input: { sourceUrl: string; text: string }): number {
  const url = new URL(input.sourceUrl);
  let score = countMarkdownLinks(input.text) + countMarkdownHeadings(input.text) * 3;
  if (/full/i.test(url.pathname)) score += 60;
  if (/medium/i.test(url.pathname)) score += 40;
  if (/small/i.test(url.pathname)) score -= 30;
  return score;
}

function getLinkedLlmsTextUrls(text: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)]+)\)/g)) {
    const href = match[1]?.trim();
    if (href !== undefined) addLinkedLlmsTextUrl(urls, href, baseUrl);
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    addLinkedLlmsTextUrl(urls, cleanUrl(match[0]) ?? match[0], baseUrl);
  }
  return [...urls];
}

function addLinkedLlmsTextUrl(urls: Set<string>, href: string, baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return;
  }
  const base = new URL(baseUrl);
  if (url.origin !== base.origin) return;
  if (!/llms/i.test(url.pathname) || !/\.txt$/i.test(url.pathname)) return;
  if (url.toString() === base.toString()) return;
  urls.add(url.toString());
}

function extractOfficialDocsEntries(text: string, sourceUrl: string): OfficialDocsEntry[] {
  const entries: OfficialDocsEntry[] = [];
  const seen = new Set<string>();
  const headingStack = new Map<number, string>();
  let currentHeading: string | undefined;

  for (const rawLine of getDocsIndexLogicalLines(text)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const headingMatch = /^(#{2,6})\s+(.+)$/.exec(line);
    if (headingMatch !== null) {
      const level = headingMatch[1]?.length ?? 2;
      const title = cleanDocsHeadingTitle(headingMatch[2] ?? "");
      if (title.length > 0) {
        for (const existingLevel of [...headingStack.keys()]) {
          if (existingLevel >= level) headingStack.delete(existingLevel);
        }
        headingStack.set(level, title);
        currentHeading = title;
      }
    }

    for (const match of line.matchAll(/\[([^\]\n]+)\]\(([^)]+)\)/g)) {
      const title = cleanDocsEntryTitle(match[1] ?? "");
      const url = normalizeOfficialDocsEntryUrl(match[2] ?? "", sourceUrl);
      addOfficialDocsEntry(entries, seen, {
        group: formatDocsHeadingGroup(headingStack),
        title,
        url,
      });
    }

    const explicitUrlMatch = /^URL:\s*(https?:\/\/\S+)/i.exec(line);
    if (explicitUrlMatch !== null) {
      addOfficialDocsEntry(entries, seen, {
        group: formatDocsHeadingGroup(headingStack),
        title: currentHeading ?? formatDocsHeadingGroup(headingStack) ?? "Documentation",
        url: explicitUrlMatch[1] ?? "",
      });
    }
  }

  return entries.slice(0, MAX_OFFICIAL_DOCS_ENTRIES);
}

function getDocsIndexLogicalLines(text: string): string[] {
  return prettifyDocsIndex(text).split("\n");
}

function formatDocsHeadingGroup(headingStack: Map<number, string>): string | undefined {
  const headings = [...headingStack.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, title]) => title)
    .filter((title, index, titles) => title.length > 0 && titles.indexOf(title) === index)
    .slice(0, 4);

  return headings.length === 0 ? undefined : headings.join(" / ");
}

function addOfficialDocsEntry(
  entries: OfficialDocsEntry[],
  seen: Set<string>,
  entry: OfficialDocsEntry,
): void {
  if (entry.title.length === 0 || entry.url.length === 0) return;
  if (isPlaceholderDocsTitle(entry.title) || isPlaceholderDocsUrl(entry.url)) return;
  if (!/^https?:\/\//i.test(entry.url)) return;
  const key = entry.url.replace(/\/$/, "");
  if (seen.has(key)) return;
  seen.add(key);
  entries.push(entry);
}

function filterOfficialDocsEntriesForSource(
  sourceUrl: string,
  entries: OfficialDocsEntry[],
): OfficialDocsEntry[] {
  if (entries.length < 20) return entries;

  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return entries;
  }

  const filtered = entries.filter((entry) => isFirstPartyDocsEntry(entry, source));
  if (filtered.length >= Math.min(20, Math.floor(entries.length * 0.5))) {
    return filtered;
  }

  return entries;
}

function isFirstPartyDocsEntry(entry: OfficialDocsEntry, source: URL): boolean {
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return false;
  }

  if (!isAllowedDocsUrl(url.toString())) return false;
  if (!isSameFirstPartyDocsHost(url, source)) return false;
  if (isNoisyOfficialDocsEntryTitle(entry.title)) return false;

  const path = url.pathname.toLowerCase();
  if (path === "/" || path.length < 2) return false;
  if (hasMalformedDocsPath(path)) return false;
  if (isNonDocumentationPagePath(path)) return false;
  if (/\.(png|jpe?g|gif|webp|svg|css|js|json|ico|pdf|zip|gz|tgz|ics)$/i.test(path)) return false;
  if (/\/(?:icons?|assets?|images?|fonts?)\//i.test(path)) return false;

  return (
    isDocsHost(url) ||
    isDocsHost(source) ||
    /\/(docs?|documentation|learn|guide|guides|api|reference|manual|manuals|book|contents|developer|tutorial|tutorials|examples?|cookbook|runtime|deploy|cli|sdk|framework|fundamentals|concepts|components|commands|configuration|extensions?|start|quickstart|how-to|explanation|upgrade|migration|library|standard-library|install|installation|formatter|linter|analyzer|auth|authentication|database|realtime|functions?|edge-functions?|ai|models?|providers?|embeddings?|vectors?|search)(\/|$)/.test(path) ||
    hasLikelyDocsPageShape(url)
  );
}

function isSameFirstPartyDocsHost(url: URL, source: URL): boolean {
  if (url.hostname === source.hostname) return true;
  return getRegistrableHost(url.hostname) === getRegistrableHost(source.hostname);
}

function isNoisyOfficialDocsEntryTitle(title: string): boolean {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");

  return /^(anchor|edit|here|this guide|thumbs? up(?: icon)?|thumbs? down(?: icon)?|copy|view source|source|github)$/i.test(normalized) ||
    isNoisyRepositoryFallbackHeading(normalized);
}

function filterOfficialDocsEntriesForRepository(
  entries: OfficialDocsEntry[],
  snapshot: PreparedRepositoryWorkspace,
): OfficialDocsEntry[] {
  if (entries.length < 20) return entries;

  const owner = snapshot.owner.toLowerCase();
  const repo = snapshot.repo.toLowerCase();
  if (owner === "modelcontextprotocol" && (
    repo === "typescript-sdk" ||
    repo === "python-sdk" ||
    repo === "servers" ||
    repo === "modelcontextprotocol"
  )) {
    const docsEntries = entries.filter((entry) => {
      try {
        const path = new URL(entry.url).pathname.toLowerCase();
        return /^\/(?:docs|specification)\//.test(path);
      } catch {
        return false;
      }
    });
    if (docsEntries.length >= 20) return docsEntries;
  }

  if (owner === "pydantic" && repo === "pydantic-ai") {
    const aiDocsEntries = entries.filter((entry) => {
      try {
        const url = new URL(entry.url);
        return /(?:^|\.)pydantic\.dev$/i.test(url.hostname) &&
          url.pathname.toLowerCase().startsWith("/docs/ai/");
      } catch {
        return false;
      }
    });
    if (aiDocsEntries.length >= 20) return aiDocsEntries;
  }

  if (owner === "langchain-ai" && repo === "langsmith-sdk") {
    const langSmithDocsEntries = entries.filter((entry) => {
      try {
        const url = new URL(entry.url);
        return url.hostname === "docs.langchain.com" &&
          url.pathname.toLowerCase().startsWith("/langsmith");
      } catch {
        return false;
      }
    });
    if (langSmithDocsEntries.length >= 20) return langSmithDocsEntries;
  }

  return entries;
}

function formatOfficialDocsEntriesIndex(sourceUrl: string, entries: OfficialDocsEntry[]): string {
  const groups = new Map<string, OfficialDocsEntry[]>();
  for (const entry of entries.slice(0, MAX_OFFICIAL_DOCS_ENTRIES)) {
    const group = entry.group ?? getCoverageLabelFromUrl(entry.url) ?? "Documentation";
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }

  const lines = [
    "# Official Documentation Index",
    "",
    `The following first-party documentation links were scoped from ${sourceUrl}.`,
  ];

  for (const [group, groupEntries] of groups) {
    lines.push("", `## ${group}`);
    for (const entry of groupEntries.slice(0, 40)) {
      lines.push(`- [${entry.title}](${entry.url})`);
    }
  }

  return lines.join("\n");
}

function normalizeOfficialDocsEntryUrl(href: string, sourceUrl: string): string {
  try {
    const url = new URL(href.trim(), sourceUrl);
    return url.toString();
  } catch {
    return "";
  }
}

function cleanDocsEntryTitle(value: string): string {
  return decodeHtmlAttribute(value)
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s*§\s*$/g, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanDocsHeadingTitle(value: string): string {
  const trimmed = value.trim();
  const linkedTitle = /^\[([^\]\n]+)\]\([^)]+\)/.exec(trimmed)?.[1];
  if (linkedTitle !== undefined) return cleanDocsEntryTitle(linkedTitle);

  const beforeInlineList = trimmed.split(/\s+-\s+\[/).at(0) ?? trimmed;
  return cleanDocsEntryTitle(beforeInlineList);
}

function selectOfficialDocsEntriesForPage(input: {
  entries: OfficialDocsEntry[];
  page: {
    purpose: string;
    slug: string;
    title: string;
  };
}): OfficialDocsEntry[] {
  const keywords = getPageKeywords(input.page);
  if (keywords.length === 0) return input.entries.slice(0, MAX_OFFICIAL_DOCS_PAGE_SNIPPETS);

  const scored = input.entries
    .map((entry, index) => ({
      entry,
      index,
      score: scoreOfficialDocsEntryForPage(entry, keywords, input.page),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (scored.length === 0) return input.entries.slice(0, MAX_OFFICIAL_DOCS_PAGE_SNIPPETS);

  const significantTitleWords = getSignificantPageTitleConcepts(input.page.title)
    .map(compactText)
    .filter((word, index, words) => word.length >= 3 && words.indexOf(word) === index);
  const selected: OfficialDocsEntry[] = [];
  for (const word of significantTitleWords) {
    const item = scored.find((candidate) =>
      !selected.some((entry) => entry.url === candidate.entry.url) &&
      !selected.some((entry) => getOfficialDocsTitleKey(entry) === getOfficialDocsTitleKey(candidate.entry)) &&
      entryCoversCompactWord(candidate.entry, word)
    );
    if (item === undefined) continue;
    selected.push(item.entry);
    if (selected.length >= MAX_OFFICIAL_DOCS_PAGE_SNIPPETS) break;
  }

  for (const item of scored) {
    if (selected.length >= MAX_OFFICIAL_DOCS_PAGE_SNIPPETS) break;
    if (selected.some((entry) => entry.url === item.entry.url)) continue;
    if (selected.some((entry) => getOfficialDocsTitleKey(entry) === getOfficialDocsTitleKey(item.entry))) continue;
    selected.push(item.entry);
    if (selected.length >= MAX_OFFICIAL_DOCS_PAGE_SNIPPETS) break;
  }

  return selectSupplementalOfficialDocsEntries({
    entries: input.entries,
    page: input.page,
    selected,
  });
}

function selectSupplementalOfficialDocsEntries(input: {
  entries: OfficialDocsEntry[];
  page: {
    purpose: string;
    slug: string;
    title: string;
  };
  selected: OfficialDocsEntry[];
}): OfficialDocsEntry[] {
  if (!isGettingStartedPage(input.page)) return input.selected;

  const selected = [...input.selected];
  const addEntry = (entry: OfficialDocsEntry | undefined, force = false): void => {
    if (entry === undefined) return;
    if (selected.some((candidate) => candidate.url === entry.url)) return;
    if (selected.length >= MAX_OFFICIAL_DOCS_PAGE_SNIPPETS) {
      if (!force || selected.length <= 1) return;
      selected.pop();
    }
    selected.push(entry);
  };

  addEntry(findBestOfficialDocsEntry(input.entries, /(introduction|overview|project[- ]layout|agent[- ]config)/i), true);
  addEntry(findBestOfficialDocsEntry(input.entries, /(connections?|mcp|openapi|open api)/i), true);
  addEntry(findBestOfficialDocsEntry(input.entries, /(tools?|skills?|channels?|sandbox|subagents?|schedules?)/i));

  return selected.slice(0, MAX_OFFICIAL_DOCS_PAGE_SNIPPETS);
}

function isGettingStartedPage(page: {
  purpose: string;
  slug: string;
  title: string;
}): boolean {
  return /\b(getting[- ]started|quickstart|quick[- ]start|installation|setup)\b/i.test(
    `${page.slug} ${page.title} ${page.purpose}`,
  );
}

function findBestOfficialDocsEntry(
  entries: OfficialDocsEntry[],
  pattern: RegExp,
): OfficialDocsEntry | undefined {
  return entries
    .map((entry, index) => ({
      entry,
      index,
      score: scoreSupplementalOfficialDocsEntry(entry, pattern),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .at(0)?.entry;
}

function scoreSupplementalOfficialDocsEntry(entry: OfficialDocsEntry, pattern: RegExp): number {
  const text = `${entry.group ?? ""} ${entry.title} ${entry.url}`;
  if (!pattern.test(text)) return 0;

  let score = 1;
  if (pattern.test(entry.title)) score += 80;
  if (entry.group !== undefined && pattern.test(entry.group)) score += 28;
  if (pattern.test(entry.url)) score += 18;
  if (/\/docs?\//i.test(entry.url)) score += 8;
  if (isNoisyOfficialDocsEntryTitle(entry.title)) score -= 100;
  return score;
}

function getPageKeywords(page: {
  purpose: string;
  slug: string;
  title: string;
}): string[] {
  const stopWords = new Set([
    "and",
    "are",
    "component",
    "components",
    "example",
    "examples",
    "for",
    "from",
    "guide",
    "guides",
    "how",
    "integration",
    "integrations",
    "into",
    "overview",
    "page",
    "pattern",
    "patterns",
    "reference",
    "the",
    "this",
    "to",
    "using",
    "with",
  ]);
  return [...new Set(
    `${page.title} ${page.slug} ${page.purpose}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !stopWords.has(word))
      .flatMap(getKeywordVariants),
  )].slice(0, 24);
}

function getKeywordVariants(word: string): string[] {
  const variants = new Set([word]);
  if (word.endsWith("ies") && word.length > 4) variants.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ing") && word.length > 5) {
    const stem = word.slice(0, -3);
    variants.add(stem);
    variants.add(`${stem}e`);
  }
  if (word.endsWith("ed") && word.length > 4) variants.add(word.slice(0, -2));
  if (word.endsWith("s") && word.length > 4) variants.add(word.slice(0, -1));
  return [...variants].filter((variant) => variant.length >= 3);
}

function scoreOfficialDocsEntryForPage(
  entry: OfficialDocsEntry,
  keywords: string[],
  page: {
    slug: string;
    title: string;
  },
): number {
  const title = compactText(entry.title);
  const group = compactText(entry.group ?? "");
  const url = compactText(entry.url);
  const pageTitle = compactText(page.title);
  const pageSlug = compactText(page.slug);
  const titleWords = new Set(tokenizeDocsText(entry.title));
  const pageWords = new Set(tokenizeDocsText(`${page.title} ${page.slug}`));
  const significantTitleWords = getSignificantPageTitleWords(page.title);
  const isReferenceLikePage = /\b(api|reference|config|configuration|option|directive|function|component|file|cli|command)\b/i
    .test(`${page.title} ${page.slug}`);

  let score = 0;
  let hasDirectSignal = false;
  if (pageTitle.length >= 4 && title.includes(pageTitle)) {
    score += 55;
    hasDirectSignal = true;
  }
  if (pageSlug.length >= 4 && url.includes(pageSlug)) {
    score += 34;
    hasDirectSignal = true;
  }

  let significantTitleHits = 0;
  for (const word of significantTitleWords) {
    const compact = compactText(word);
    if (title.includes(compact)) {
      score += 24;
      significantTitleHits += 1;
      hasDirectSignal = true;
    }
    if (title.startsWith(compact)) score += 46;
    if (titleWords.has(word)) {
      score += 12;
      hasDirectSignal = true;
    }
    if (url.includes(compact)) {
      score += 8;
      significantTitleHits += 1;
      hasDirectSignal = true;
    }
  }
  if (significantTitleWords.length > 0 && significantTitleHits === 0) score -= 28;
  if (significantTitleWords.length >= 2 && significantTitleHits >= 2) score += 18;

  let titleHits = 0;
  for (const keyword of keywords) {
    const compact = compactText(keyword);
    if (compact.length < 3) continue;
    if (title.includes(compact)) {
      score += 14;
      titleHits += 1;
      hasDirectSignal = true;
    }
    if (titleWords.has(keyword)) {
      score += 7;
      hasDirectSignal = true;
    }
    if (group.includes(compact)) {
      score += 9;
      hasDirectSignal = true;
    }
    if (url.includes(compact)) {
      score += 3;
      hasDirectSignal = true;
    }
    if (url.includes(`/${compact}`) || url.includes(`-${compact}`)) {
      score += 3;
      hasDirectSignal = true;
    }
  }

  if (!hasDirectSignal) return 0;

  if (titleHits >= 2) score += titleHits * 9;
  if ([...pageWords].some((word) => titleWords.has(word))) score += 8;
  if (/(gettingstarted|learn|guide|guides|concept|concepts|tutorial|quickstart|quickstarts)/.test(group)) score += 6;
  if (!isReferenceLikePage && /\/learn\//.test(entry.url)) score += 14;
  if (!isReferenceLikePage && /\/api-reference\/config\//.test(entry.url)) score -= 24;
  if (!isReferenceLikePage && /\/api-reference\//.test(entry.url)) score -= 8;
  if (!isReferenceLikePage && /\/reference\/rules\//.test(entry.url)) score -= 120;
  if (!isReferenceLikePage && /\/reference\/eslint-plugin-react-hooks\//.test(entry.url)) score -= 120;
  if (isGenericOfficialDocsEntryTitle(entry.title) && !pageTitle.includes(title)) score -= 18;
  if (/overview|introduction|gettingstarted|quickstart/.test(title)) score += 3;
  return score;
}

function entryCoversCompactWord(entry: OfficialDocsEntry, compactWord: string): boolean {
  return tokenizeDocsText(`${entry.title} ${entry.url}`)
    .map(compactText)
    .some((word) => word === compactWord);
}

function getOfficialDocsTitleKey(entry: OfficialDocsEntry): string {
  return compactText(entry.title);
}

function getSignificantPageTitleWords(title: string): string[] {
  return [...new Set(
    getSignificantPageTitleConcepts(title).flatMap(getKeywordVariants),
  )].slice(0, 8);
}

function getSignificantPageTitleConcepts(title: string): string[] {
  const generic = new Set([
    "api",
    "app",
    "and",
    "components",
    "documentation",
    "guide",
    "guides",
    "or",
    "overview",
    "reference",
    "router",
    "the",
  ]);
  return [...new Set(tokenizeDocsText(title)
    .filter((word) => word.length >= 3 && !generic.has(word)))].slice(0, 8);
}

function tokenizeDocsText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

function isGenericOfficialDocsEntryTitle(title: string): boolean {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
  return /^(adapters?|agents?|api|apis|architecture|auth|authentication|best practices|cli|commands?|components?|concepts?|config|configuration|database|databases|directives?|docs?|documentation|edge functions?|embeddings?|errors?|examples?|faq|foundations?|functions?|fundamentals?|getting started|guides?|hooks?|installation|integrations?|introduction|limits?|lints?|models?|options?|overview|pricing|providers?|quick start|quickstart|realtime|reference|resources?|routes?|routing|schemas?|search|security|setup|storage|tools?|troubleshooting|tutorials?|types?|vectors?)$/i
    .test(normalized);
}

function extractReadableHtmlText(text: string, entry?: OfficialDocsEntry): string {
  const scopedText = extractAnchoredHtmlSection(text, entry) ?? text;
  return decodeHtmlAttribute(
    scopedText
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(h[1-6]|p|li|pre|tr|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n"),
  ).trim();
}

function extractAnchoredHtmlSection(text: string, entry: OfficialDocsEntry | undefined): string | undefined {
  if (entry === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return undefined;
  }

  const rawHash = url.hash.slice(1);
  if (rawHash.length === 0) return undefined;

  const decodedHash = safelyDecodeUriComponent(rawHash);
  const idIndex = findHtmlIdIndex(text, [rawHash, decodedHash]);
  if (idIndex === undefined) return undefined;

  const sectionStart = findHeadingStartAtOrBefore(text, idIndex) ?? findTagStartAtOrBefore(text, idIndex);
  if (sectionStart === undefined) return undefined;

  const headingLevel = getHeadingLevelAt(text, sectionStart) ?? 2;
  const sectionEnd = findNextHeadingBoundary(text, sectionStart + 1, headingLevel) ?? text.length;
  const section = text.slice(sectionStart, sectionEnd).trim();
  if (section.length < 200) return undefined;
  return section;
}

function findHtmlIdIndex(text: string, candidates: string[]): number | undefined {
  const ids = new Set(
    candidates
      .flatMap((candidate) => [candidate, decodeHtmlAttribute(candidate), safelyDecodeUriComponent(candidate)])
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.length > 0),
  );
  if (ids.size === 0) return undefined;

  for (const match of text.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    if (match.index === undefined) continue;
    const rawId = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const decodedId = decodeHtmlAttribute(safelyDecodeUriComponent(rawId)).trim();
    if (ids.has(rawId) || ids.has(decodedId)) return match.index;
  }

  return undefined;
}

function findHeadingStartAtOrBefore(text: string, index: number): number | undefined {
  const pattern = /<h([1-6])\b[^>]*>/gi;
  let headingStart: number | undefined;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > index) break;
    headingStart = match.index;
  }

  return headingStart;
}

function findTagStartAtOrBefore(text: string, index: number): number | undefined {
  const tagStart = text.lastIndexOf("<", index);
  const tagEnd = text.indexOf(">", index);
  if (tagStart === -1 || tagEnd === -1) return undefined;
  if (tagEnd < tagStart) return undefined;
  return tagStart;
}

function getHeadingLevelAt(text: string, index: number): number | undefined {
  const match = /^<h([1-6])\b/i.exec(text.slice(index, index + 12));
  if (match?.[1] === undefined) return undefined;
  return Number.parseInt(match[1], 10);
}

function findNextHeadingBoundary(text: string, fromIndex: number, currentLevel: number): number | undefined {
  const pattern = /<h([1-6])\b/gi;
  pattern.lastIndex = fromIndex;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const level = Number.parseInt(match[1] ?? "6", 10);
    if (level <= currentLevel) return match.index;
  }

  return undefined;
}

function safelyDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isLikelySitemap(sourceUrl: string, text: string): boolean {
  const url = new URL(sourceUrl);
  return (
    url.pathname.endsWith(".xml") ||
    /^\s*<\?xml/.test(text) ||
    /^\s*<(urlset|sitemapindex)\b/i.test(text)
  );
}

function isLikelyHtml(text: string): boolean {
  const prologue = text.slice(0, 4096);
  return (
    /^\s*<!doctype html/i.test(prologue) ||
    /^\s*<html\b/i.test(prologue) ||
    (
      /<(?:head|body|main|nav|article|section)\b/i.test(prologue) &&
      /<(?:title|meta|link|script)\b/i.test(prologue)
    ) ||
    (
      /<a\s[^>]*href=/i.test(prologue) &&
      /<\/a>/i.test(prologue) &&
      /<h[1-6]\b/i.test(prologue)
    )
  );
}

async function createHtmlDocsBody(
  candidate: OfficialDocsCandidate,
  text: string,
): Promise<OfficialDocsBody | undefined> {
  let docsUrls = dedupeUrls(extractHtmlDocLinks(text, candidate))
    .sort(compareDocsUrls);
  docsUrls = filterDocsUrlsForSourceScope(candidate, docsUrls);
  if (docsUrls.length < 10) {
    docsUrls = dedupeUrls([
      ...docsUrls,
      ...await extractJavaScriptDocLinks(text, candidate),
    ]).sort(compareDocsUrls);
    docsUrls = filterDocsUrlsForSourceScope(candidate, docsUrls);
  }
  if (docsUrls.length >= 10 && docsUrls.length < 60) {
    docsUrls = dedupeUrls([
      ...docsUrls,
      ...await expandLinkedHtmlDocLinks(candidate, docsUrls),
    ]).sort(compareDocsUrls);
    docsUrls = filterDocsUrlsForSourceScope(candidate, docsUrls);
  }
  const headings = extractHtmlHeadingLinks(text, candidate);
  if (headings.length >= 10 && shouldPreferHtmlHeadingIndex({
    candidate,
    docsUrlCount: docsUrls.length,
    headingCount: headings.length,
  })) {
    const headingIndex = formatHtmlHeadingIndex(candidate.sourceUrl, headings);
    return {
      headingCount: countMarkdownHeadings(headingIndex),
      linkCount: headings.length,
      sourceUrl: candidate.sourceUrl,
      text: headingIndex,
    };
  }

  if (docsUrls.length < 10) {
    if (
      docsUrls.length >= 5 &&
      isAdjacentOfficialDocsSource(new URL(candidate.sourceUrl), candidate.snapshot)
    ) {
      const compactIndex = formatHtmlDocsIndex(candidate.sourceUrl, docsUrls);
      const compactHeadingCount = countMarkdownHeadings(compactIndex);
      if (compactHeadingCount >= 2) {
        return {
          headingCount: compactHeadingCount,
          linkCount: docsUrls.length,
          sourceUrl: candidate.sourceUrl,
          text: compactIndex,
        };
      }
    }

    if (headings.length < 10) return undefined;

    const headingIndex = formatHtmlHeadingIndex(candidate.sourceUrl, headings);
    return {
      headingCount: countMarkdownHeadings(headingIndex),
      linkCount: headings.length,
      sourceUrl: candidate.sourceUrl,
      text: headingIndex,
    };
  }

  const textIndex = formatHtmlDocsIndex(candidate.sourceUrl, docsUrls);
  const headingCount = countMarkdownHeadings(textIndex);
  if (headingCount < 2) return undefined;

  return {
    headingCount,
    linkCount: docsUrls.length,
    sourceUrl: candidate.sourceUrl,
    text: textIndex,
  };
}

function shouldPreferHtmlHeadingIndex(input: {
  candidate: OfficialDocsCandidate;
  docsUrlCount: number;
  headingCount: number;
}): boolean {
  if (input.headingCount >= Math.max(30, input.docsUrlCount * 3)) return true;
  const path = new URL(input.candidate.sourceUrl).pathname.toLowerCase();
  return (
    input.headingCount >= 20 &&
    /\/(documentation|reference|manual|manuals|book|contents)(\/|\.html|$)/.test(path)
  );
}

function extractHtmlDocLinks(text: string, candidate: OfficialDocsCandidate): URL[] {
  const urls: URL[] = [];
  for (const match of text.matchAll(/\bhref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (
      href.length === 0 ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("javascript:")
    ) {
      continue;
    }

    let url: URL;
    try {
      url = new URL(href, candidate.sourceUrl);
    } catch {
      continue;
    }

    url.hash = "";
    if (isLikelyDocsPageUrl(url, candidate)) {
      urls.push(url);
    }
  }
  return urls;
}

function filterDocsUrlsForSourceScope(
  candidate: OfficialDocsCandidate,
  urls: URL[],
): URL[] {
  if (urls.length < 10) return urls;

  const source = getDocsScopeUrl(candidate);
  const sourceSegments = getPathSegments(source);

  if (source.hostname === "learn.microsoft.com" && /^\/en-us\/semantic-kernel(?:\/|$)/i.test(source.pathname)) {
    const semanticKernelScoped = urls.filter((url) =>
      url.hostname === source.hostname &&
      /^\/en-us\/semantic-kernel(?:\/|$)/i.test(url.pathname)
    );
    if (semanticKernelScoped.length >= 10) return semanticKernelScoped;
  }

  if (/^(?:scikit-learn\.org|docs\.jax\.dev|triton-lang\.org|webllm\.mlc\.ai)$/i.test(source.hostname)) {
    const sourceRoot = getDocsScopeRootSegments(source);
    if (sourceRoot.length > 0) {
      const rootScoped = urls.filter((url) => {
        const segments = getPathSegments(url).map((segment) => segment.toLowerCase());
        return sourceRoot.every((segment, index) => segments.at(index) === segment);
      });
      if (rootScoped.length >= 5 && isAdjacentOfficialDocsSource(source, candidate.snapshot)) return rootScoped;
      if (rootScoped.length >= 10) return rootScoped;
    }
  }

  const locale = getLeadingLocaleSegment(sourceSegments);
  if (locale !== undefined) {
    const localeScoped = urls.filter((url) => getPathSegments(url).at(0)?.toLowerCase() === locale);
    if (localeScoped.length >= 10) return localeScoped;
  } else {
    const defaultLanguageUrls = urls.filter((url) => getLeadingLocaleSegment(getPathSegments(url)) === undefined);
    if (defaultLanguageUrls.length >= 10) return defaultLanguageUrls;
  }

  if (/^\/oss\/(?:python|javascript)(?:\/|$)/i.test(source.pathname)) {
    const [ossSegment, languageSegment] = sourceSegments;
    if (ossSegment !== undefined && languageSegment !== undefined) {
      const ossScoped = urls.filter((url) => {
        const [entryOssSegment, entryLanguageSegment] = getPathSegments(url);
        return (
          entryOssSegment?.toLowerCase() === ossSegment.toLowerCase() &&
          entryLanguageSegment?.toLowerCase() === languageSegment.toLowerCase()
        );
      });
      if (ossScoped.length >= 10) return ossScoped;
    }
  }

  return urls;
}

function getDocsScopeUrl(candidate: OfficialDocsCandidate): URL {
  const source = new URL(candidate.sourceUrl);
  const discoveredFrom = new URL(candidate.discoveredFrom);
  if (
    source.origin === discoveredFrom.origin &&
    /^\/(?:llms(?:-full)?\.txt|sitemap\.xml)$/i.test(source.pathname) &&
    getPathSegments(discoveredFrom).length >= 2
  ) {
    return discoveredFrom;
  }

  return source;
}

function getLeadingLocaleSegment(segments: string[]): string | undefined {
  const firstSegment = segments.at(0)?.toLowerCase();
  return firstSegment !== undefined && /^[a-z]{2}(?:-[a-z]{2})?$/.test(firstSegment)
    ? firstSegment
    : undefined;
}

function getDocsScopeRootSegments(source: URL): string[] {
  const segments = getPathSegments(source).map((segment) => segment.toLowerCase());
  if (source.hostname === "scikit-learn.org") return segments.slice(0, 1);
  if (source.hostname === "docs.jax.dev") return segments.slice(0, 2);
  if (source.hostname === "triton-lang.org") return segments.slice(0, 1);
  if (source.hostname === "webllm.mlc.ai") return segments.slice(0, 1);
  return [];
}

async function expandLinkedHtmlDocLinks(
  candidate: OfficialDocsCandidate,
  docsUrls: URL[],
): Promise<URL[]> {
  const expanded: URL[] = [];
  const expansionTargets = docsUrls
    .filter((url) => url.toString() !== candidate.sourceUrl)
    .sort((a, b) => scoreHtmlExpansionUrl(b) - scoreHtmlExpansionUrl(a))
    .slice(0, 8);

  for (const url of expansionTargets) {
    const response = await fetchText(url.toString(), {
      accept: "text/html, text/plain, */*;q=0.5",
    });
    if (response === undefined || !isLikelyHtml(response.text)) continue;
    const linkedCandidate = {
      ...candidate,
      sourceUrl: response.sourceUrl,
    };
    expanded.push(...extractHtmlDocLinks(response.text, linkedCandidate));
  }

  return expanded;
}

function scoreHtmlExpansionUrl(url: URL): number {
  const path = url.pathname.toLowerCase();
  let score = 0;
  if (/\/(learn|docs?|documentation|book|reference|api|manual|manuals|guide|guides|contents)(\/|index\.html|$)/.test(path)) score += 50;
  if (/\/(tutorial|getting-started|quickstart|fundamentals|library|standard-library|cargo|rustdoc|rustc)(\/|index\.html|$)/.test(path)) score += 25;
  if (/\/(blog|news|community|support|download|install|policy|license)(\/|$)/.test(path)) score -= 50;
  if (/\/[a-z]{2}(?:-[a-z]{2})?\//i.test(path) && !/^\/en(?:-[a-z]{2})?\//i.test(path)) score -= 40;
  return score;
}

function extractHtmlHeadingLinks(
  text: string,
  candidate: OfficialDocsCandidate,
): Array<{ level: number; title: string; url: string }> {
  const headings: Array<{ level: number; title: string; url: string }> = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(/<h([1-4])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)) {
    const level = Number.parseInt(match[1] ?? "2", 10);
    const attrs = match[2] ?? "";
    const html = match[3] ?? "";
    const title = decodeHtmlAttribute(stripHtmlTags(html)).replace(/\s+/g, " ").trim();
    if (title.length < 2 || title.length > 120) continue;
    if (/^(copy|edit this page|on this page)$/i.test(title)) continue;

    const idMatch = /\bid=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const id = decodeHtmlAttribute(idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? "").trim();
    const url = new URL(candidate.sourceUrl);
    if (id.length > 0) url.hash = id;
    const key = `${level}:${title.toLowerCase()}:${url.toString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    headings.push({
      level,
      title,
      url: url.toString(),
    });
  }

  return headings.slice(0, MAX_HTML_HEADING_LINKS);
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

async function extractJavaScriptDocLinks(
  html: string,
  candidate: OfficialDocsCandidate,
): Promise<URL[]> {
  const scriptUrls = extractHtmlAssetUrls(html, candidate)
    .filter((url) => url.pathname.endsWith(".js"))
    .slice(0, 8);

  const urls: URL[] = [];
  for (const scriptUrl of scriptUrls) {
    const response = await fetchText(scriptUrl.toString(), {
      accept: "text/javascript, application/javascript, */*;q=0.5",
    });
    if (response === undefined) continue;
    for (const url of extractJavaScriptRouteUrls(response.text, candidate)) {
      urls.push(url);
    }
  }
  return urls;
}

function extractHtmlAssetUrls(text: string, candidate: OfficialDocsCandidate): URL[] {
  const urls: URL[] = [];
  for (const match of text.matchAll(/\b(?:href|src)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (href.length === 0 || href.startsWith("data:")) continue;
    let url: URL;
    try {
      url = new URL(href, candidate.sourceUrl);
    } catch {
      continue;
    }
    if (isRelatedDocsHost(url, candidate)) {
      urls.push(url);
    }
  }
  return dedupeUrls(urls);
}

function extractJavaScriptRouteUrls(text: string, candidate: OfficialDocsCandidate): URL[] {
  const urls: URL[] = [];
  for (const match of text.matchAll(/["'`]((?:\/[A-Za-z0-9][A-Za-z0-9_./-]*))["'`]/g)) {
    const path = match[1];
    if (path === undefined || !isLikelyDocsRoutePath(path)) continue;
    let url: URL;
    try {
      url = new URL(path, candidate.sourceUrl);
    } catch {
      continue;
    }
    if (isLikelyDocsPageUrl(url, candidate) || isLikelyFrameworkDocsRoute(url)) {
      urls.push(url);
    }
  }
  return urls;
}

function isLikelyDocsRoutePath(path: string): boolean {
  if (/\.(png|jpe?g|gif|webp|svg|css|js|json|ico|pdf|zip|gz|tgz)$/i.test(path)) return false;
  if (/^\/(assets?|images?|fonts?|styles?|scripts?|support|sponsors?|discover)(\/|$)/i.test(path)) return false;
  return path.split("/").filter(Boolean).length <= 4;
}

function isLikelyFrameworkDocsRoute(url: URL): boolean {
  const firstSegment = getPathSegments(url).at(0)?.toLowerCase();
  if (firstSegment === undefined) return false;
  return /^(first-steps|controllers|providers|modules|middleware|exception-filters|pipes|guards|interceptors|custom-decorators|fundamentals|techniques|security|graphql|websockets|microservices|deployment|standalone-applications|cli|openapi|recipes|faq|devtools|migration-guide|home|start|how-to|explanation|api|upgrading|tutorials|guides)$/.test(firstSegment);
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function formatHtmlDocsIndex(sourceUrl: string, urls: URL[]): string {
  return [
    "# Official Documentation Navigation",
    "",
    `The following first-party documentation links were discovered from ${sourceUrl}.`,
    "",
    ...formatDocsUrlGroups(urls),
  ].join("\n");
}

function formatHtmlHeadingIndex(
  sourceUrl: string,
  headings: Array<{ level: number; title: string; url: string }>,
): string {
  const lines = [
    "# Official Documentation Structure",
    "",
    `The following first-party documentation sections were discovered from ${sourceUrl}.`,
  ];

  let currentGroup = "";
  for (const heading of headings) {
    if (heading.level <= 2) {
      currentGroup = heading.title;
      lines.push("", `## [${heading.title}](${heading.url})`);
      continue;
    }

    if (currentGroup.length === 0) {
      currentGroup = "Documentation";
      lines.push("", "## Documentation");
    }
    lines.push(`- [${heading.title}](${heading.url})`);
  }

  return lines.join("\n");
}

async function createSitemapDocsBody(
  candidate: OfficialDocsCandidate,
  text: string,
): Promise<OfficialDocsBody | undefined> {
  let docsUrls = extractSitemapLocs(text)
    .filter((url) => isLikelyDocsPageUrl(url, candidate));

  if (docsUrls.length === 0) {
    const nestedCandidates = extractSitemapLocs(text)
      .filter((url) => isLikelyNestedDocsSitemapUrl(url, candidate));
    const hasEnglishSitemap = nestedCandidates.some(isEnglishNestedSitemapUrl);
    const nestedSitemaps = nestedCandidates
      .filter((url) => !hasEnglishSitemap || isEnglishNestedSitemapUrl(url) || hasDocsSitemapPath(url))
      .sort((a, b) => scoreNestedSitemapUrl(b) - scoreNestedSitemapUrl(a))
      .slice(0, 6);

    const nestedDocs = new Set<string>();
    for (const sitemapUrl of nestedSitemaps) {
      const response = await fetchText(sitemapUrl.toString(), {
        accept: "application/xml, text/xml, */*;q=0.5",
      });
      if (response === undefined) continue;
      for (const url of extractSitemapLocs(response.text)) {
        if (isLikelyDocsPageUrl(url, candidate)) nestedDocs.add(url.toString());
      }
    }
    docsUrls = [...nestedDocs].map((url) => new URL(url));
  }

  docsUrls = filterDocsUrlsForSourceScope(candidate, docsUrls);
  docsUrls = filterBroadTopicSitemapDocs(candidate, docsUrls);
  const uniqueDocsUrls = dedupeUrls(docsUrls)
    .sort(compareDocsUrls);
  if (uniqueDocsUrls.length < 10) return undefined;

  const textIndex = formatSitemapDocsIndex(uniqueDocsUrls);
  const headingCount = countMarkdownHeadings(textIndex);
  if (headingCount < 2) return undefined;

  return {
    headingCount,
    linkCount: uniqueDocsUrls.length,
    sourceUrl: candidate.sourceUrl,
    text: textIndex,
  };
}

function extractSitemapLocs(text: string): URL[] {
  const urls: URL[] = [];
  for (const match of text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    const loc = match[1]?.trim();
    if (loc === undefined) continue;
    try {
      urls.push(new URL(loc));
    } catch {
      // Ignore malformed sitemap entries.
    }
  }
  return urls;
}

function filterBroadTopicSitemapDocs(
  candidate: OfficialDocsCandidate,
  docsUrls: URL[],
): URL[] {
  if (docsUrls.length < 200) return docsUrls;

  const source = new URL(candidate.sourceUrl);
  const snapshot = candidate.snapshot;
  if (isDockerEngineDocsContext(source, snapshot)) {
    const dockerEngineDocs = docsUrls.filter(isDockerEngineDocsUrl);
    if (dockerEngineDocs.length >= 30) return dockerEngineDocs;
  }

  const topicOnlySource =
    isTopicSpecificHostOrPath(source, snapshot) &&
    !isRepoSpecificHostOrPath(source, snapshot) &&
    !isOwnerSpecificHostOrPath(source, snapshot) &&
    !isHomepageSpecificDocsSource(source, snapshot);
  if (!topicOnlySource) return docsUrls;

  const keywords = getRepositoryPathKeywords(snapshot);
  if (keywords.length === 0) return docsUrls;

  const filtered = docsUrls.filter((url) => {
    const path = compactText(url.pathname);
    return keywords.some((keyword) => path.includes(keyword));
  });

  return filtered.length >= 30 ? filtered : docsUrls;
}

function isDockerEngineDocsContext(source: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  return (
    source.hostname === "docs.docker.com" &&
    snapshot.owner.toLowerCase() === "moby" &&
    snapshot.repo.toLowerCase() === "moby"
  );
}

function isDockerEngineDocsUrl(url: URL): boolean {
  return /^\/(?:engine(?:\/|$)|reference\/api\/engine(?:\/|$)|reference\/cli\/docker(?:\/|$)|build(?:\/|$)|get-started\/docker-concepts(?:\/|$))/.test(url.pathname.toLowerCase());
}

function isLikelyNestedDocsSitemapUrl(url: URL, candidate: OfficialDocsCandidate): boolean {
  if (!isRelatedDocsHost(url, candidate)) return false;
  const path = url.pathname.toLowerCase();
  return (
    path.endsWith(".xml") &&
    (
      /(doc|docs|documentation|learn|guide|guides|api|reference|manual|manuals|book|contents|developer|tutorial|runtime|framework|fundamentals|library|engine|cli|sdk|auth|authentication|database|storage|realtime|functions?|ai|models?|providers?|embeddings?|vectors?|search)/.test(path) ||
      /^\/sitemap\/sitemap-\d+\.xml$/.test(path) ||
      /^\/[a-z]{2}(?:-[a-z]{2})?\/sitemap\.xml$/.test(path)
    )
  );
}

function scoreNestedSitemapUrl(url: URL): number {
  let score = 0;
  if (isEnglishNestedSitemapUrl(url)) score += 100;
  if (hasDocsSitemapPath(url)) score += 50;
  if (/\/latest\//i.test(url.pathname)) score += 20;
  return score;
}

function isEnglishNestedSitemapUrl(url: URL): boolean {
  return /^\/en(?:-[a-z]{2})?\/sitemap\.xml$/i.test(url.pathname);
}

function hasDocsSitemapPath(url: URL): boolean {
  return /(doc|docs|documentation|learn|guide|guides|api|reference|manual|manuals|book|contents|developer|tutorial|runtime|framework|fundamentals|library|engine|cli|sdk|auth|authentication|database|storage|realtime|functions?|formatter|linter|analyzer|ai|models?|providers?|embeddings?|vectors?|search)/i.test(url.pathname);
}

function isLikelyDocsPageUrl(url: URL, candidate: OfficialDocsCandidate): boolean {
  if (!isRelatedDocsHost(url, candidate)) return false;
  const path = url.pathname.toLowerCase();
  if (path.endsWith(".xml")) return false;
  if (/\.(png|jpe?g|gif|webp|svg|css|js|json|ico|pdf|zip|gz|tgz|ics)$/i.test(path)) return false;
  if (path === "/" || path.length < 2) return false;
  if (hasMalformedDocsPath(path)) return false;
  if (isPlaceholderDocsUrl(url.toString())) return false;
  if (isNonDocumentationPagePath(path)) return false;

  return (
    /\/(docs?|documentation|learn|guide|guides|api|reference|manual|manuals|book|contents|developer|tutorial|tutorials|examples?|cookbook|runtime|deploy|cli|sdk|framework|fundamentals|concepts|components|commands|configuration|extensions?|start|quickstart|how-to|explanation|upgrade|migration|library|standard-library|install|installation|engine|containers?|images?|daemon|network|storage|swarm|compose|build|auth|authentication|database|realtime|functions?|edge-functions?|formatter|linter|analyzer|ai|models?|providers?|embeddings?|vectors?|search)(\/|$)/.test(path) ||
    (isDocsHost(url) && hasLikelyDocsPageShape(url)) ||
    (isAdjacentOfficialDocsSource(new URL(candidate.sourceUrl), candidate.snapshot) && hasLikelyDocsPageShape(url)) ||
    isProjectSpecificPath(url, candidate.snapshot)
  );
}

function isPlaceholderDocsTitle(title: string): boolean {
  return /^(undefined|null|nan|none|tbd|todo)$/i.test(title.trim());
}

function isPlaceholderDocsUrl(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    return getPathSegments(url).some((segment) => /^(undefined|null|nan|none|tbd|todo)$/i.test(segment));
  } catch {
    return false;
  }
}

function hasMalformedDocsPath(path: string): boolean {
  return /(?:%3c|%3e|<\/?script|customelements\.define|\.tostring\(\))/i.test(path);
}

function isNonDocumentationPagePath(path: string): boolean {
  return (
    /\/(?:404|not-found)(?:[/.]|$)/.test(path) ||
    /^\/dl\/?$/.test(path) ||
    /\/(blog|news|pricing|showcase|customers|partners|events|careers|contact|login|signin|signup|support|guidelines|brand|legal|privacy|terms|security-advisories|tags)(?:[/.]|$)/.test(path) ||
    /\/_(?:sources|downloads)\//.test(path) ||
    /\/(?:genindex|search)\.html$/.test(path)
  );
}

function isDocsHost(url: URL): boolean {
  const primary = url.hostname.toLowerCase().replace(/^www\./, "").split(".").at(0) ?? "";
  return /^(docs?|documentation|learn|developer)$/.test(primary);
}

function hasLikelyDocsPageShape(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  if (path === "/" || path.length < 2) return false;
  if (isNonDocumentationPagePath(path) || /\/(about|company)(\/|$)/.test(path)) {
    return false;
  }
  return getPathSegments(url).length <= 6;
}

function isRelatedDocsHost(url: URL, candidate: OfficialDocsCandidate): boolean {
  const source = new URL(candidate.sourceUrl);
  if (url.hostname === source.hostname) return true;

  const sourceParts = source.hostname.split(".");
  const targetParts = url.hostname.split(".");
  const sourceRoot = sourceParts.slice(-2).join(".");
  const targetRoot = targetParts.slice(-2).join(".");
  return sourceRoot === targetRoot;
}

function dedupeUrls(urls: URL[]): URL[] {
  const seen = new Set<string>();
  const result: URL[] = [];
  for (const url of urls) {
    url.hash = "";
    const key = url.toString().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(url);
  }
  return result;
}

function compareDocsUrls(a: URL, b: URL): number {
  return getDocsUrlSortKey(a).localeCompare(getDocsUrlSortKey(b));
}

function getDocsUrlSortKey(url: URL): string {
  const path = url.pathname.toLowerCase();
  if (/\/(learn|getting-started|quickstart|tutorial)/.test(path)) return `0:${path}`;
  if (/\/(docs?|guide|guides|manual|book)/.test(path)) return `1:${path}`;
  if (/\/(api|reference)/.test(path)) return `2:${path}`;
  if (/\/(examples?|cookbook)/.test(path)) return `3:${path}`;
  return `4:${path}`;
}

function formatSitemapDocsIndex(urls: URL[]): string {
  return [
    "# Official Documentation Sitemap",
    "",
    "The following first-party documentation pages were discovered from the public sitemap.",
    "",
    ...formatDocsUrlGroups(urls),
  ].join("\n");
}

function formatDocsUrlGroups(urls: URL[]): string[] {
  const groups = new Map<string, URL[]>();
  const sampledUrls = selectBalancedSitemapDocsUrls(urls, MAX_SITEMAP_DOC_LINKS)
    .sort(compareDocsUrls);
  for (const url of sampledUrls) {
    const group = getSitemapDocsGroup(url);
    groups.set(group, [...(groups.get(group) ?? []), url]);
  }

  const lines: string[] = [];

  for (const [group, groupUrls] of groups) {
    lines.push("", `## ${group}`);
    for (const url of groupUrls) {
      lines.push(`- [${titleFromDocsUrl(url)}](${url.toString()})`);
    }
  }

  return lines;
}

function selectBalancedSitemapDocsUrls(urls: URL[], maxCount: number): URL[] {
  if (urls.length <= maxCount) return urls;

  const groups = new Map<string, URL[]>();
  for (const url of urls) {
    const group = getSitemapDocsGroup(url);
    groups.set(group, [...(groups.get(group) ?? []), url]);
  }

  const orderedGroups = [...groups.entries()]
    .sort((a, b) => scoreSitemapDocsGroup(b[0], b[1].length) - scoreSitemapDocsGroup(a[0], a[1].length));
  const selected: URL[] = [];
  let cursor = 0;

  while (selected.length < maxCount && orderedGroups.length > 0) {
    const groupIndex = cursor % orderedGroups.length;
    const [, groupUrls] = orderedGroups[groupIndex] as [string, URL[]];
    const next = groupUrls.shift();
    if (next !== undefined) selected.push(next);

    if (groupUrls.length === 0) {
      orderedGroups.splice(groupIndex, 1);
      cursor = 0;
    } else {
      cursor += 1;
    }
  }

  return selected;
}

function scoreSitemapDocsGroup(group: string, urlCount: number): number {
  let score = Math.min(urlCount, 80);
  if (/(getting started|quick start|quickstart|installation|setup|tutorial|learn|start)/i.test(group)) score += 90;
  if (/(concept|foundation|architecture|fundamentals?|overview)/i.test(group)) score += 75;
  if (/(guide|workflow|usage|how to|integration|deploy|testing|migration|upgrade)/i.test(group)) score += 65;
  if (/(api|reference|configuration|command|cli|components?|functions?|hooks?)/i.test(group)) score += 55;
  if (/(example|cookbook|recipe|troubleshoot|error|faq)/i.test(group)) score += 45;
  if (/(ai|agent|models?|providers?|embeddings?|vectors?|search|database|storage|auth|authentication|realtime|edge functions?)/i.test(group)) score += 58;
  return score;
}

function getSitemapDocsGroup(url: URL): string {
  const segments = getPathSegments(url);
  const docsIndex = segments.findIndex((segment) =>
    /^(docs?|documentation|learn|guide|guides|api|reference|manual|manuals|book|contents|developer|tutorial|examples?|cookbook|runtime|deploy|cli|sdk|framework|fundamentals|concepts|components|commands|configuration|extensions?|library|standard-library|engine|containers?|images?|daemon|network|storage|swarm|compose|build|formatter|linter|analyzer|auth|authentication|database|databases|realtime|functions?|edge-functions?|ai|models?|providers?|embeddings?|vectors?|search)$/.test(segment),
  );
  if (docsIndex >= 0) {
    const sectionSegment = segments.at(docsIndex) ?? "docs";
    const previousSegment = segments.at(docsIndex - 1);
    if (
      (docsIndex === 0 && !/^(docs?|documentation|manual|manuals)$/.test(sectionSegment)) ||
      (previousSegment !== undefined && isVersionPathSegment(previousSegment))
    ) {
      return titleFromSlugPath([sectionSegment, getDocsSubgroupSegment(segments, docsIndex + 1)]);
    }
  }
  const groupSegment = docsIndex >= 0
    ? (segments.at(docsIndex + 1) ?? segments.at(docsIndex) ?? "docs")
    : (segments.at(0) ?? "docs");
  const subgroupSegment = docsIndex >= 0
    ? getDocsSubgroupSegment(segments, docsIndex + 2)
    : getDocsSubgroupSegment(segments, 1);
  return titleFromSlugPath([groupSegment, subgroupSegment]);
}

function isVersionPathSegment(segment: string): boolean {
  return /^(?:v?\d+(?:\.\d+)*|latest|stable|current)$/.test(segment.toLowerCase());
}

function getDocsSubgroupSegment(segments: string[], index: number): string | undefined {
  const segment = segments.at(index);
  if (segment === undefined) return undefined;
  if (/^(index|overview|introduction|getting-started|quickstart|install|installation)$/.test(segment.toLowerCase())) {
    return undefined;
  }
  return segment;
}

function titleFromSlugPath(segments: Array<string | undefined>): string {
  return segments
    .filter((segment): segment is string => segment !== undefined && segment.length > 0)
    .slice(0, 2)
    .map(titleFromSlug)
    .join(" / ") || "Documentation";
}

function titleFromDocsUrl(url: URL): string {
  const segments = getPathSegments(url);
  const lastSegment = segments.at(-1) ?? url.hostname;
  return titleFromSlug(lastSegment);
}

function titleFromSlug(slug: string): string {
  return slug
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => {
      if (/^(api|cli|sdk|ui|ssr|ssg|jsx|tsx|css|html|http|url|json|sql|orm)$/i.test(word)) {
        return word.toUpperCase();
      }
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ") || "Documentation";
}

function getPathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getLikelyDocsIndexUrls(
  rawUrl: string,
  snapshot: PreparedRepositoryWorkspace,
): string[] {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }

  const candidates = new Set<string>();
  const cleanPath = url.pathname.replace(/\/+$/, "");
  candidates.add(url.toString());
  candidates.add(new URL("/llms.txt", url.origin).toString());
  candidates.add(new URL("/llms-full.txt", url.origin).toString());
  candidates.add(new URL("/sitemap.xml", url.origin).toString());
  candidates.add(new URL("/sitemap/sitemap-index.xml", url.origin).toString());
  if (isProjectSpecificHostOrPath(url, snapshot) || isTopicSpecificHostOrPath(url, snapshot) || isRelatedToHomepageHost(url, snapshot)) {
    for (const docsPath of getLikelyDocsLandingPaths(snapshot)) {
      candidates.add(new URL(docsPath, url.origin).toString());
    }
  }
  if (isProjectSpecificHostOrPath(url, snapshot) || isTopicSpecificHostOrPath(url, snapshot) || isRelatedToHomepageHost(url, snapshot) || cleanPath.startsWith("/docs")) {
    candidates.add(new URL("/docs/llms.txt", url.origin).toString());
    candidates.add(new URL("/docs/sitemap.xml", url.origin).toString());
  }

  if (cleanPath.length > 0 && !/\.[A-Za-z0-9]+$/.test(cleanPath)) {
    candidates.add(url.toString());
    candidates.add(new URL(`${cleanPath}/llms.txt`, url.origin).toString());
    candidates.add(new URL(`${cleanPath}/llms-full.txt`, url.origin).toString());
    candidates.add(new URL(`${cleanPath}/sitemap.xml`, url.origin).toString());
    candidates.add(new URL(`${cleanPath}/contents.html`, url.origin).toString());
  }

  for (const projectDocsPath of getProjectDocsPathPrefixes(url, snapshot)) {
    candidates.add(new URL(projectDocsPath, url.origin).toString());
    candidates.add(new URL(`${projectDocsPath}/llms.txt`, url.origin).toString());
    candidates.add(new URL(`${projectDocsPath}/llms-full.txt`, url.origin).toString());
    candidates.add(new URL(`${projectDocsPath}/sitemap.xml`, url.origin).toString());
    candidates.add(new URL(`${projectDocsPath}/contents.html`, url.origin).toString());
  }

  for (const docsRootPath of getDocsRootPathPrefixes(url)) {
    candidates.add(new URL(docsRootPath, url.origin).toString());
    candidates.add(new URL(`${docsRootPath}/llms.txt`, url.origin).toString());
    candidates.add(new URL(`${docsRootPath}/llms-full.txt`, url.origin).toString());
    candidates.add(new URL(`${docsRootPath}/sitemap.xml`, url.origin).toString());
  }

  const firstSegment = cleanPath.split("/").filter(Boolean).at(0);
  if (firstSegment !== undefined && /^(docs|documentation|learn|reference|guide|guides|api|manual|manuals|book|contents)$/i.test(firstSegment)) {
    candidates.add(new URL(`/${firstSegment}/llms.txt`, url.origin).toString());
    candidates.add(new URL(`/${firstSegment}/sitemap.xml`, url.origin).toString());
  }
  if (firstSegment !== undefined && /^\d+(?:\.\d+)?$/.test(firstSegment)) {
    const majorVersion = firstSegment.split(".").at(0);
    candidates.add(new URL(`/${firstSegment}/`, url.origin).toString());
    candidates.add(new URL(`/${firstSegment}/contents.html`, url.origin).toString());
    if (majorVersion !== undefined) {
      candidates.add(new URL(`/${majorVersion}/`, url.origin).toString());
      candidates.add(new URL(`/${majorVersion}/contents.html`, url.origin).toString());
      candidates.add(new URL(`/${majorVersion}/library/index.html`, url.origin).toString());
      candidates.add(new URL(`/${majorVersion}/reference/index.html`, url.origin).toString());
      candidates.add(new URL(`/${majorVersion}/tutorial/index.html`, url.origin).toString());
    }
  }

  for (const docsOrigin of getLikelyDocsSubdomainOrigins(url)) {
    candidates.add(new URL("/", docsOrigin).toString());
    candidates.add(new URL("/llms.txt", docsOrigin).toString());
    candidates.add(new URL("/llms-full.txt", docsOrigin).toString());
    candidates.add(new URL("/docs/llms.txt", docsOrigin).toString());
    candidates.add(new URL("/sitemap.xml", docsOrigin).toString());
    for (const docsPath of getLikelyLocalizedDocsLandingPaths()) {
      candidates.add(new URL(docsPath, docsOrigin).toString());
    }
    for (const docsPath of getLikelyDocsLandingPaths(snapshot)) {
      candidates.add(new URL(docsPath, docsOrigin).toString());
    }
  }

  for (const exactOrigin of getLikelyExactProjectOrigins(snapshot)) {
    candidates.add(new URL("/llms.txt", exactOrigin).toString());
    candidates.add(new URL("/llms-full.txt", exactOrigin).toString());
    candidates.add(new URL("/sitemap.xml", exactOrigin).toString());
    for (const docsPath of getLikelyDocsLandingPaths(snapshot)) {
      candidates.add(new URL(docsPath, exactOrigin).toString());
    }
  }

  return [...candidates];
}

function getKnownOfficialDocsSeedUrls(snapshot: PreparedRepositoryWorkspace): string[] {
  const owner = snapshot.owner.toLowerCase();
  const repo = snapshot.repo.toLowerCase();

  if (owner === "openai" && repo === "openai-cookbook") {
    return [
      "https://developers.openai.com/cookbook/llms.txt",
      "https://cookbook.openai.com/llms.txt",
      "https://cookbook.openai.com/",
    ];
  }

  if (owner === "openai" && repo.startsWith("openai-")) {
    return [
      "https://platform.openai.com/docs/llms.txt",
    ];
  }

  if (owner === "openai" && repo === "codex") {
    return [
      "https://developers.openai.com/codex/llms.txt",
    ];
  }

  if (owner === "openai" && repo === "openai-agents-python") {
    return [
      "https://openai.github.io/openai-agents-python/sitemap.xml",
      "https://openai.github.io/openai-agents-python/",
    ];
  }

  if (owner === "openai" && repo === "openai-agents-js") {
    return [
      "https://openai.github.io/openai-agents-js/",
    ];
  }

  if (owner === "anthropics" && repo === "anthropic-sdk-typescript") {
    return [
      "https://docs.anthropic.com/en/api/client-sdks",
      "https://docs.anthropic.com/llms.txt",
    ];
  }

  if (owner === "anthropics" && repo === "anthropic-sdk-python") {
    return [
      "https://docs.anthropic.com/en/api/client-sdks",
      "https://docs.anthropic.com/llms.txt",
    ];
  }

  if (owner === "pydantic" && repo === "pydantic-ai") {
    return [
      "https://ai.pydantic.dev/llms.txt",
      "https://ai.pydantic.dev/sitemap.xml",
    ];
  }

  if (owner === "langchain-ai" && repo === "langchain") {
    return [
      "https://docs.langchain.com/oss/python/langchain/overview",
    ];
  }

  if (owner === "langchain-ai" && repo === "langchainjs") {
    return [
      "https://docs.langchain.com/oss/javascript/langchain/overview",
    ];
  }

  if (owner === "langchain-ai" && repo === "langsmith-sdk") {
    return [
      "https://docs.langchain.com/langsmith/observability",
      "https://docs.langchain.com/langsmith/evaluation",
      "https://docs.smith.langchain.com/",
    ];
  }

  if (owner === "withastro" && repo === "astro") {
    return [
      "https://docs.astro.build/en/getting-started/",
    ];
  }

  if (owner === "moby" && repo === "moby") {
    return [
      "https://docs.docker.com/engine/",
      "https://docs.docker.com/sitemap.xml",
    ];
  }

  if (owner === "golang" && repo === "go") {
    return [
      "https://go.dev/doc/",
      "https://go.dev/ref/spec",
    ];
  }

  if (owner === "python" && repo === "cpython") {
    return [
      "https://docs.python.org/3/contents.html",
      "https://docs.python.org/3/tutorial/",
      "https://docs.python.org/3/library/",
    ];
  }

  if (owner === "apache" && repo === "spark") {
    return [
      "https://spark.apache.org/docs/latest/",
      "https://spark.apache.org/sitemap.xml",
    ];
  }

  if (owner === "llvm" && repo === "llvm-project") {
    return [
      "https://llvm.org/docs/",
      "https://llvm.org/docs/GettingStarted.html",
    ];
  }

  if (owner === "modelcontextprotocol" && (
    repo === "typescript-sdk" ||
    repo === "python-sdk" ||
    repo === "servers" ||
    repo === "modelcontextprotocol"
  )) {
    return [
      "https://modelcontextprotocol.io",
      "https://modelcontextprotocol.io/quickstart/server",
      "https://modelcontextprotocol.io/examples",
    ];
  }

  if (owner === "microsoft" && repo === "autogen") {
    return [
      "https://microsoft.github.io/autogen/stable/",
      "https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html",
    ];
  }

  if (owner === "dotnet" && repo === "runtime") {
    return [
      "https://learn.microsoft.com/en-us/dotnet/fundamentals/",
      "https://learn.microsoft.com/en-us/dotnet/core/introduction",
    ];
  }

  if (owner === "microsoft" && repo === "playwright") {
    return [
      "https://playwright.dev/docs/intro",
      "https://playwright.dev/sitemap.xml",
    ];
  }

  if (owner === "denoland" && repo === "deno") {
    return [
      "https://docs.deno.com/llms.txt",
      "https://docs.deno.com/llms-summary.txt",
      "https://docs.deno.com/sitemap.xml",
      "https://docs.deno.com/runtime/",
    ];
  }

  if (owner === "biomejs" && repo === "biome") {
    return [
      "https://biomejs.dev/",
      "https://biomejs.dev/guides/getting-started/",
      "https://biomejs.dev/formatter/",
      "https://biomejs.dev/linter/",
    ];
  }

  if (owner === "vercel" && repo === "v0") {
    return [
      "https://v0.app/docs/sitemap.xml",
      "https://v0.app/docs",
    ];
  }

  if (owner === "vercel" && repo === "workflow") {
    return [
      "https://workflow-sdk.dev/sitemap.xml",
      "https://workflow-sdk.dev/docs/getting-started",
    ];
  }

  if (owner === "vercel" && repo === "ai-elements") {
    return [
      "https://elements.ai-sdk.dev/llms.txt",
      "https://elements.ai-sdk.dev/sitemap.xml",
    ];
  }

  if (owner === "microsoft" && repo === "semantic-kernel") {
    return [
      "https://learn.microsoft.com/en-us/semantic-kernel/overview/",
    ];
  }

  if (owner === "google" && (repo === "adk-python" || repo === "adk-js")) {
    return [
      "https://adk.dev/llms.txt",
      "https://adk.dev/",
    ];
  }

  if (owner === "scikit-learn" && repo === "scikit-learn") {
    return [
      "https://scikit-learn.org/stable/user_guide.html",
    ];
  }

  if (owner === "jax-ml" && repo === "jax") {
    return [
      "https://docs.jax.dev/en/latest/",
      "https://docs.jax.dev/en/latest/index.html",
    ];
  }

  if (owner === "rollup" && repo === "rollup") {
    return [
      "https://rollupjs.org/introduction/",
    ];
  }

  if (owner === "remix-run" && repo === "react-router") {
    return [
      "https://reactrouter.com/home",
      "https://reactrouter.com/start/framework/installation",
      "https://reactrouter.com/start/data/routing",
    ];
  }

  if (owner === "webpack" && repo === "webpack") {
    return [
      "https://webpack.js.org/concepts/",
      "https://webpack.js.org/sitemap.xml",
    ];
  }

  if (owner === "pmndrs" && repo === "react-three-fiber") {
    return [
      "https://r3f.docs.pmnd.rs/llms.txt",
      "https://r3f.docs.pmnd.rs/getting-started/introduction",
      "https://docs.pmnd.rs/react-three-fiber/llms.txt",
      "https://docs.pmnd.rs/react-three-fiber/getting-started/introduction",
    ];
  }

  if (owner === "remix-run" && repo === "remix") {
    return [
      "https://v2.remix.run/docs/",
    ];
  }

  if (owner === "payloadcms" && repo === "payload") {
    return [
      "https://payloadcms.com/docs",
      "https://payloadcms.com/llms.txt",
    ];
  }

  if (owner === "nrwl" && repo === "nx") {
    return [
      "https://nx.dev/docs",
      "https://nx.dev/llms.txt",
    ];
  }

  if (owner === "googleapis" && repo === "js-genai") {
    return [
      "https://googleapis.github.io/js-genai/release_docs/index.html",
      "https://googleapis.github.io/js-genai/release_docs/modules.html",
    ];
  }

  if (owner === "triton-lang" && repo === "triton") {
    return [
      "https://triton-lang.org/main/index.html",
    ];
  }

  if (owner === "mlc-ai" && repo === "web-llm") {
    return [
      "https://webllm.mlc.ai/docs/",
      "https://webllm.mlc.ai/docs/index.html",
    ];
  }

  if (owner === "vercel" && repo === "components.build") {
    return [
      "https://components.build/llms.txt",
      "https://components.build/docs",
    ];
  }

  return [];
}

function getDocsRootPathPrefixes(url: URL): string[] {
  const segments = getPathSegments(url);
  const docsRootIndex = segments.findIndex((segment) =>
    /^(docs?|documentation|learn|guide|guides|reference|api|manual|manuals|book|contents|developer|tutorial|tutorials)$/i.test(segment),
  );
  if (docsRootIndex < 0) return [];
  return [`/${segments.slice(0, docsRootIndex + 1).join("/")}`];
}

function getProjectDocsPathPrefixes(
  url: URL,
  snapshot: PreparedRepositoryWorkspace,
): string[] {
  const repoCompact = compactText(snapshot.repo);
  if (repoCompact.length < 3) return [];

  const segments = getPathSegments(url);
  if (segments.length < 2) return [];

  const docsRootIndex = segments.findIndex((segment) =>
    /^(docs?|documentation|learn|guide|guides|reference|api|manual|manuals|book|contents|developer|tutorial|tutorials)$/i.test(segment),
  );
  if (docsRootIndex < 0) return [];

  const repoIndex = segments.findIndex((segment) => isRepoPathSegment(segment, repoCompact));
  if (repoIndex <= docsRootIndex) return [];

  const prefixes = new Set<string>();
  prefixes.add(`/${segments.slice(0, repoIndex + 1).join("/")}`);

  const withoutIndex = segments.at(-1)?.toLowerCase() === "index"
    ? segments.slice(0, -1)
    : segments;
  if (withoutIndex.length > docsRootIndex + 1) {
    const repoIndexWithoutIndex = withoutIndex.findIndex((segment) => isRepoPathSegment(segment, repoCompact));
    if (repoIndexWithoutIndex > docsRootIndex) {
      prefixes.add(`/${withoutIndex.slice(0, repoIndexWithoutIndex + 1).join("/")}`);
    }
  }

  return [...prefixes];
}

function isRepoPathSegment(segment: string, repoCompact: string): boolean {
  const compactSegment = compactText(segment);
  return compactSegment === repoCompact || compactText(segment.replace(/\.[a-z0-9]+$/i, "")) === repoCompact;
}

function getLikelyExactProjectOrigins(snapshot: PreparedRepositoryWorkspace): string[] {
  const repo = snapshot.repo.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (repo.length < 3 || !homepagePathContainsRepo(snapshot)) return [];
  return [
    `https://${repo}.dev`,
  ];
}

function homepagePathContainsRepo(snapshot: PreparedRepositoryWorkspace): boolean {
  if (snapshot.homepageUrl === undefined) return false;
  try {
    const homepage = new URL(snapshot.homepageUrl);
    return getPathSegments(homepage).map(compactText).includes(compactText(snapshot.repo));
  } catch {
    return false;
  }
}

function getLikelyDocsLandingPaths(snapshot: PreparedRepositoryWorkspace): string[] {
  const repo = snapshot.repo.toLowerCase();
  return [
    "/docs",
    "/docs/latest",
    "/documentation",
    "/documentation/master",
    "/learn",
    "/guide",
    "/guides",
    "/reference",
    "/api",
    "/doc",
    "/manual",
    "/manuals",
    "/fundamentals",
    "/contents.html",
    `/${repo}`,
    `/${repo}/docs`,
  ];
}

function getLikelyLocalizedDocsLandingPaths(): string[] {
  return [
    "/en/getting-started/",
    "/en/docs/",
    "/en/guides/",
    "/en/reference/",
  ];
}

function getLikelyDocsSubdomainOrigins(url: URL): string[] {
  if (!/^(www\.)?[^.]+\.[^.]+$/.test(url.hostname)) return [];
  const rootHost = url.hostname.replace(/^www\./, "");
  return [
    `https://docs.${rootHost}`,
    `https://doc.${rootHost}`,
  ];
}

function cleanUrl(raw: string): string | undefined {
  const cleaned = raw.replace(/[.,;:!?]+$/, "");
  try {
    const url = new URL(cleaned);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function isLikelyProjectDocsUrl(
  rawUrl: string,
  snapshot: PreparedRepositoryWorkspace,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!isAllowedDocsUrl(url.toString())) {
    return false;
  }

  const path = url.pathname.toLowerCase();
  return (
    isProjectSpecificHostOrPath(url, snapshot) ||
    isTopicSpecificHostOrPath(url, snapshot) ||
    isRelatedToHomepageHost(url, snapshot) ||
    (/\/(docs?|documentation|learn|reference|guide|guides|api|manual|manuals|book|contents|developer|fundamentals|formatter|linter|analyzer)(\/|$)/.test(path) &&
      isProjectSpecificPath(url, snapshot))
  );
}

function isAllowedDocsUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_DOCS_HOSTS.has(hostname)) return false;
  if (BLOCKED_DOCS_HOST_SUFFIXES.some((baseHost) => isHostOrSubdomain(hostname, baseHost))) return false;
  if (BLOCKED_DOCS_HOST_SUBSTRINGS.some((token) => hostname.includes(token))) return false;
  if (isHostedDashboardOrPreviewHost(hostname)) return false;
  return true;
}

function isHostedDashboardOrPreviewHost(hostname: string): boolean {
  return HOSTED_DASHBOARD_OR_PREVIEW_HOSTS.some((baseHost) => isHostOrSubdomain(hostname, baseHost));
}

function isHostOrSubdomain(hostname: string, baseHost: string): boolean {
  return hostname === baseHost || hostname.endsWith(`.${baseHost}`);
}

function scoreCandidateUrl(
  discoveredFrom: string,
  sourceUrl: string,
  snapshot: PreparedRepositoryWorkspace,
): number {
  const from = new URL(discoveredFrom);
  const source = new URL(sourceUrl);
  const repoName = snapshot.repo.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hostnameCompact = from.hostname.toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = from.pathname.toLowerCase();
  const sourcePath = source.pathname.toLowerCase().replace(/\/+$/, "") || "/";

  let score = 0;
  if (source.toString().replace(/\/$/, "") === from.toString().replace(/\/$/, "")) score += 220;
  if (hostnameCompact.includes(repoName)) score += 50;
  if (isRepoSpecificHostOrPath(source, snapshot)) score += 160;
  else if (isOwnerSpecificHostOrPath(source, snapshot)) score += 50;
  if (isRelatedToHomepageHost(from, snapshot)) score += 80;
  if (isRepoSpecificHostOrPath(from, snapshot)) score += 80;
  if (isTopicSpecificHostOrPath(from, snapshot)) score += 35;
  if (/\/docs(\/|$)/.test(path)) score += 40;
  if (/\/(learn|guide|guides|reference|api|documentation|manuals?|contents|fundamentals|formatter|linter|analyzer)(\/|$)/.test(path)) score += 30;
  if (/\/docs?(\/|$)/.test(source.pathname)) score += 35;
  if (/\/(learn|guide|guides|reference|api|documentation|manuals?|contents|fundamentals|formatter|linter|analyzer)(\/|$)/.test(source.pathname)) score += 30;
  if (/^\/(docs?|documentation|learn|guide|guides|reference|api|manual|manuals|book|contents|developer|tutorial|tutorials|formatter|linter|analyzer)$/.test(sourcePath)) {
    score += 120;
  }
  if (/\/contents\.html$/i.test(source.pathname)) score += 80;
  if (/\/\d+(?:\.\d+)?\/(?:contents\.html)?$/i.test(source.pathname)) score += 60;
  if (/\/\d+(?:\.\d+)?\/(?:library|reference|tutorial)\/index\.html$/i.test(source.pathname)) score += 45;
  if (/\/sitemap\/sitemap-index\.xml$/i.test(source.pathname)) score += 60;
  if (source.pathname === "/llms.txt") score += 120;
  if (source.pathname.endsWith("/llms.txt")) score += 120;
  if (source.pathname.endsWith("/llms-full.txt")) score += 100;
  if (source.pathname.endsWith("/docs/llms.txt")) score += 90;
  if (isRepoScopedDocsIndexUrl(source, snapshot)) score += 180;
  if (source.pathname.endsWith("/docs/sitemap.xml")) score += 100;
  else if (source.pathname.endsWith("/sitemap.xml")) score += 35;
  if (sourcePath === "/sitemap.xml" && !isRepoSpecificHostOrPath(source, snapshot) && isRepoSpecificHostOrPath(from, snapshot)) {
    score -= 90;
  }
  if (
    (source.hostname.startsWith("docs.") || source.hostname.startsWith("doc.")) &&
    (sourcePath === "/llms.txt" || sourcePath === "/sitemap.xml")
  ) {
    score += 120;
  }
  if (source.hostname.startsWith("docs.") || source.hostname.startsWith("doc.")) score += 20;
  if (from.hostname.endsWith(".dev")) score += 10;
  return score;
}

function isRepoScopedDocsIndexUrl(url: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  const segments = getPathSegments(url);
  if (segments.length < 3) return false;
  const repoCompact = compactText(snapshot.repo);
  if (repoCompact.length < 3) return false;

  const docsRootIndex = segments.findIndex((segment) =>
    /^(docs?|documentation|learn|guide|guides|reference|api|manual|manuals|book|contents|developer|tutorial|tutorials)$/i.test(segment),
  );
  if (docsRootIndex < 0) return false;

  const repoIndex = segments.findIndex((segment) => isRepoPathSegment(segment, repoCompact));
  if (repoIndex <= docsRootIndex) return false;

  return /(?:llms(?:-full)?\.txt|sitemap\.xml|contents\.html)$/i.test(url.pathname);
}

function scoreOfficialDocsIndex(index: OfficialDocsIndex): number {
  let score = index.relevanceScore * 250 + index.candidateScore * 8 + Math.min(index.linkCount, 800) * 3 + Math.min(index.headingCount, 800) * 2;
  if (/llms-full\.txt$/i.test(index.sourceUrl)) score += index.linkCount >= 60 ? 500 : 0;
  else if (/llms.*\.txt$/i.test(index.sourceUrl)) score += index.linkCount >= 60 ? 8_000 : 2_500;
  else if (/sitemap.*\.xml$/i.test(index.sourceUrl)) score += 3_000;
  if (LANGUAGE_SPECIFIC_LLMS_INDEX_PATTERN.test(index.sourceUrl)) {
    score -= 24_000;
  }
  if (/\/docs\/sitemap\.xml$/i.test(index.sourceUrl)) score += 22_000;
  if (/\/release-notes(?:\/|$)/i.test(index.sourceUrl)) score -= 4_000;
  return score;
}

function scoreDocsIndexRelevance(input: {
  candidate: OfficialDocsCandidate;
  text: string;
}): number {
  const from = new URL(input.candidate.discoveredFrom);
  const source = new URL(input.candidate.sourceUrl);
  const snapshot = input.candidate.snapshot;
  const text = input.text.slice(0, MAX_DOCS_INDEX_CHARS).toLowerCase();
  const repoName = snapshot.repo.toLowerCase();
  const repoCompact = compactText(snapshot.repo);
  const sourceCompact = compactText(`${source.hostname}${source.pathname}`);
  const repoSpecific = isRepoSpecificHostOrPath(source, snapshot);
  const ownerSpecific = isOwnerSpecificHostOrPath(source, snapshot);
  const topicSpecific = isTopicSpecificHostOrPath(source, snapshot);
  const homepageSpecific = isHomepageSpecificDocsSource(source, snapshot);
  const adjacentOfficialDocs = isAdjacentOfficialDocsSource(source, snapshot);
  const sourceMentionsRepository = text.includes(`github.com/${snapshot.owner.toLowerCase()}/${snapshot.repo.toLowerCase()}`);
  const sourceMentionsProject = hasExactProjectMention(text, repoName) && (repoCompact.length >= 4 || repoSpecific);
  const sourceUsesRepositoryName = repoCompact.length >= 4 && sourceCompact.includes(repoCompact);
  const trustedDocsSource =
    repoSpecific ||
    ownerSpecific ||
    homepageSpecific ||
    adjacentOfficialDocs ||
    sourceMentionsRepository ||
    sourceUsesRepositoryName;

  if (!trustedDocsSource) {
    return 0;
  }

  if (isWrongAdjacentProjectDocsSource(source, snapshot)) {
    return 0;
  }

  if (
    isOverbroadOwnerDocsSource(source, snapshot) &&
    isBroadOwnerRootPath(source) &&
    !adjacentOfficialDocs &&
    !sourceMentionsRepository
  ) {
    return 0;
  }

  if (
    isOverbroadOwnerDocsSource(source, snapshot) &&
    isGeneratedOwnerDocsLandingPath(source, snapshot) &&
    !adjacentOfficialDocs &&
    !sourceMentionsRepository
  ) {
    return 0;
  }

  if (
    isOverbroadOwnerDocsSource(source, snapshot) &&
    !repoSpecific &&
    !homepageSpecific &&
    !adjacentOfficialDocs &&
    !sourceUsesRepositoryName &&
    !sourceMentionsRepository &&
    (
      requiresRepositoryNameInBroadOwnerDocs(snapshot) ||
      !sourceMentionsProject ||
      isAmbiguousOwnerProjectName(snapshot.repo)
    )
  ) {
    return 0;
  }

  if (
    topicSpecific &&
    !repoSpecific &&
    !ownerSpecific &&
    !homepageSpecific &&
    !adjacentOfficialDocs &&
    !sourceCompact.includes(repoCompact) &&
    !sourceMentionsRepository &&
    !sourceMentionsProject
  ) {
    return 0;
  }

  let score = 0;
  if (repoSpecific) score += 7;
  else if (ownerSpecific) score += 2;
  if (topicSpecific) score += 4;
  if (homepageSpecific) score += 5;
  if (adjacentOfficialDocs) score += 8;
  if (sourceCompact.includes(repoCompact) && repoCompact.length >= 5) score += 4;
  if (sourceMentionsRepository) score += 6;
  if (sourceMentionsProject) score += 3;

  const meaningfulDescriptionWords = getMeaningfulDescriptionWords(snapshot.description);
  const matchedDescriptionWords = meaningfulDescriptionWords.filter((word) => text.includes(word)).length;
  score += Math.min(4, matchedDescriptionWords);

  if (!repoSpecific && !homepageSpecific && ownerSpecific && countMarkdownLinks(text) > 300) {
    score -= 4;
  }

  if (
    source.pathname === "/docs/llms.txt" &&
    !isProjectSpecificHostOrPath(source, snapshot) &&
    !from.pathname.toLowerCase().startsWith("/docs")
  ) {
    score -= 8;
  }

  return score;
}

function isOverbroadOwnerDocsSource(source: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  const owner = snapshot.owner.toLowerCase();
  const hostname = source.hostname.toLowerCase().replace(/^www\./, "");

  return ((owner === "vercel" || owner === "vercel-labs") && hostname === "vercel.com") ||
    (owner === "openai" && (
      hostname === "developers.openai.com" ||
      hostname === "platform.openai.com" ||
      hostname === "openai.com"
    )) ||
    (owner === "microsoft" && (
      hostname === "learn.microsoft.com" ||
      hostname === "microsoft.com" ||
      hostname.endsWith(".microsoft.com")
    ));
}

function requiresRepositoryNameInBroadOwnerDocs(snapshot: PreparedRepositoryWorkspace): boolean {
  const owner = snapshot.owner.toLowerCase();
  return owner === "microsoft" || owner === "openai";
}

function isWrongAdjacentProjectDocsSource(source: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  const owner = snapshot.owner.toLowerCase();
  const repo = snapshot.repo.toLowerCase();
  const hostname = source.hostname.toLowerCase().replace(/^www\./, "");

  if (
    owner === "openai" &&
    (
      repo === "openai-agents-python" ||
      repo === "openai-agents-js" ||
      repo === "openai-cookbook"
    ) &&
    !(repo === "openai-cookbook" && hostname === "developers.openai.com" && source.pathname.toLowerCase().startsWith("/cookbook")) &&
    hostname !== "openai.github.io"
  ) {
    return true;
  }

  if (
    owner === "openai" &&
    hostname !== "openai.github.io" &&
    !/(?:^|\.)openai\.com$/i.test(hostname)
  ) {
    return true;
  }

  return owner === "pmndrs" &&
    repo === "react-three-fiber" &&
    hostname === "drei.docs.pmnd.rs";
}

function isBroadOwnerRootPath(source: URL): boolean {
  return source.pathname.replace(/\/+$/, "") === "";
}

function isGeneratedOwnerDocsLandingPath(source: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  const repoPath = snapshot.repo.toLowerCase();
  const sourcePath = source.pathname.toLowerCase().replace(/\/+$/, "");
  return sourcePath === `/${repoPath}` || sourcePath === `/${repoPath}/docs`;
}

function isAmbiguousOwnerProjectName(repo: string): boolean {
  return /^(?:ai|api|arg|avatar|flags|fun|ms|ncc|nft|pkg|release|serve|storage|title|workflow)$/.test(
    repo.toLowerCase(),
  );
}

function isAdjacentOfficialDocsSource(source: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  return isDockerEngineDocsContext(source, snapshot) ||
    isAnthropicSdkDocsContext(source, snapshot) ||
    isBiomeDocsContext(source, snapshot) ||
    isSeededOfficialDocsContext(source, snapshot);
}

function isAnthropicSdkDocsContext(source: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  return (
    snapshot.owner.toLowerCase() === "anthropics" &&
    (snapshot.repo.toLowerCase() === "anthropic-sdk-typescript" || snapshot.repo.toLowerCase() === "anthropic-sdk-python") &&
    /(?:^|\.)claude\.com$/i.test(source.hostname)
  ) || (
    snapshot.owner.toLowerCase() === "anthropics" &&
    (snapshot.repo.toLowerCase() === "anthropic-sdk-typescript" || snapshot.repo.toLowerCase() === "anthropic-sdk-python") &&
    /(?:^|\.)anthropic\.com$/i.test(source.hostname)
  );
}

function isBiomeDocsContext(source: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  return snapshot.owner.toLowerCase() === "biomejs" &&
    snapshot.repo.toLowerCase() === "biome" &&
    /(?:^|\.)biomejs\.dev$/i.test(source.hostname);
}

function isSeededOfficialDocsContext(source: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  const owner = snapshot.owner.toLowerCase();
  const repo = snapshot.repo.toLowerCase();
  const hostname = source.hostname.toLowerCase();
  const path = source.pathname.toLowerCase();

  return (
    owner === "microsoft" &&
    repo === "semantic-kernel" &&
    hostname === "learn.microsoft.com" &&
    path.startsWith("/en-us/semantic-kernel")
  ) || (
    owner === "google" &&
    (repo === "adk-python" || repo === "adk-js") &&
    /(?:^|\.)adk\.dev$/i.test(hostname)
  ) || (
    owner === "scikit-learn" &&
    repo === "scikit-learn" &&
    /(?:^|\.)scikit-learn\.org$/i.test(hostname)
  ) || (
    owner === "python" &&
    repo === "cpython" &&
    hostname === "docs.python.org" &&
    path.startsWith("/3/")
  ) || (
    owner === "openai" &&
    repo.startsWith("openai-") &&
    (
      (repo === "openai-cookbook" && hostname === "developers.openai.com" && path.startsWith("/cookbook")) ||
      (repo !== "openai-cookbook" && /(?:^|\.)platform\.openai\.com$/i.test(hostname)) ||
      (repo !== "openai-cookbook" && /(?:^|\.)developers\.openai\.com$/i.test(hostname)) ||
      (
        hostname === "openai.github.io" &&
        (
          path.startsWith(`/${repo}`) ||
          (repo === "openai-agents-python" && path.startsWith("/openai-agents-python")) ||
          (repo === "openai-agents-js" && path.startsWith("/openai-agents-js"))
        )
      )
    )
  ) || (
    owner === "langchain-ai" &&
    repo === "langsmith-sdk" &&
    (
      (hostname === "docs.langchain.com" && path.startsWith("/langsmith")) ||
      /(?:^|\.)docs\.smith\.langchain\.com$/i.test(hostname)
    )
  ) || (
    owner === "jax-ml" &&
    repo === "jax" &&
    /(?:^|\.)jax\.dev$/i.test(hostname)
  ) || (
    owner === "rollup" &&
    repo === "rollup" &&
    /(?:^|\.)rollupjs\.org$/i.test(hostname)
  ) || (
    owner === "remix-run" &&
    repo === "react-router" &&
    /(?:^|\.)reactrouter\.com$/i.test(hostname)
  ) || (
    owner === "webpack" &&
    repo === "webpack" &&
    /(?:^|\.)webpack\.js\.org$/i.test(hostname)
  ) || (
    owner === "pmndrs" &&
    repo === "react-three-fiber" &&
    (
      hostname === "r3f.docs.pmnd.rs" ||
      (hostname === "docs.pmnd.rs" && path.startsWith("/react-three-fiber"))
    )
  ) || (
    owner === "remix-run" &&
    repo === "remix" &&
    /(?:^|\.)remix\.run$/i.test(hostname)
  ) || (
    owner === "payloadcms" &&
    repo === "payload" &&
    /(?:^|\.)payloadcms\.com$/i.test(hostname)
  ) || (
    owner === "nrwl" &&
    repo === "nx" &&
    /(?:^|\.)nx\.dev$/i.test(hostname)
  ) || (
    owner === "googleapis" &&
    repo === "js-genai" &&
    hostname === "googleapis.github.io" &&
    path.startsWith("/js-genai/")
  ) || (
    owner === "triton-lang" &&
    repo === "triton" &&
    /(?:^|\.)triton-lang\.org$/i.test(hostname)
  ) || (
    owner === "mlc-ai" &&
    repo === "web-llm" &&
    /(?:^|\.)webllm\.mlc\.ai$/i.test(hostname)
  ) || (
    owner === "llvm" &&
    repo === "llvm-project" &&
    hostname === "llvm.org" &&
    path.startsWith("/docs")
  ) || (
    owner === "apache" &&
    repo === "spark" &&
    /(?:^|\.)spark\.apache\.org$/i.test(hostname)
  ) || (
    owner === "dotnet" &&
    repo === "runtime" &&
    hostname === "learn.microsoft.com" &&
    path.startsWith("/en-us/dotnet")
  ) || (
    owner === "pydantic" &&
    repo === "pydantic-ai" &&
    /(?:^|\.)pydantic\.dev$/i.test(hostname) &&
    path.startsWith("/docs/ai")
  ) || (
    owner === "vercel" &&
    repo === "components.build" &&
    /(?:^|\.)components\.build$/i.test(hostname)
  ) || (
    owner === "vercel" &&
    repo === "ai-elements" &&
    /(?:^|\.)elements\.ai-sdk\.dev$/i.test(hostname)
  ) || (
    owner === "vercel" &&
    repo === "workflow" &&
    /(?:^|\.)workflow-sdk\.dev$/i.test(hostname)
  );
}

function prettifyDocsIndex(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+(#{2,6}\s+)/g, "\n$1")
    .replace(/\s+-\s+\[/g, "\n- [")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatOfficialDocsCoverageGroups(entries: OfficialDocsEntry[]): string {
  const groups = getOfficialDocsCoverageGroups(entries);
  return groups
    .slice(0, 18)
    .map((group) => `- ${group.label}: ${group.count} linked page${group.count === 1 ? "" : "s"}`)
    .join("\n");
}

function getOfficialDocsCoverageGroups(entries: OfficialDocsEntry[]): Array<{
  count: number;
  label: string;
}> {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    const labels = new Set<string>();
    for (const label of entry.group?.split(/\s+\/\s+/) ?? []) {
      const cleaned = normalizeCoverageLabel(label);
      if (isUsefulCoverageLabel(cleaned)) labels.add(cleaned);
    }
    const urlLabel = getCoverageLabelFromUrl(entry.url);
    if (urlLabel !== undefined && isUsefulCoverageLabel(urlLabel)) labels.add(urlLabel);

    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ count, label }))
    .filter((group) => group.count >= 2)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function getCoverageLabelFromUrl(sourceUrl: string): string | undefined {
  try {
    const url = new URL(sourceUrl);
    const segments = getPathSegments(url)
      .filter((segment) => !isVersionPathSegment(segment))
      .filter((segment) => !/^(docs?|documentation|app|pages|en|latest|current|stable)$/i.test(segment));
    const candidate = segments.find((segment) =>
      /^(learn|getting-started|quickstart|guide|guides|api-reference|api|reference|hooks|components|functions|configuration|config|cli|architecture|examples|cookbook|migration|upgrade|troubleshooting|testing|deployment|deploying|routing|caching|rendering|data-fetching|file-system-conventions|directives|compiler|auth|authentication|database|databases|storage|realtime|edge-functions|vector|vectors|embeddings|embedding|ai|models|model|providers|provider|agents|agent|tools|tool|skills|skill|channels|channel|connections|connection|mcp|openapi|open-api|sandbox|subagents|subagent|schedules|schedule|evals|eval|sessions|session|streaming|instructions|instruction|inference|search)$/i.test(segment),
    );
    return candidate === undefined ? undefined : normalizeCoverageLabel(candidate);
  } catch {
    return undefined;
  }
}

function normalizeCoverageLabel(label: string): string {
  return label
    .replace(/\s+/g, " ")
    .replace(/[-_]+/g, " ")
    .trim()
    .split(" ")
    .map((word) => {
      if (/^(api|cli|css|dom|html|jsx|mcp|mdx|openapi|pwa|rsc|sdk|ui|url)$/i.test(word)) {
        return word.toUpperCase();
      }
      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function isUsefulCoverageLabel(label: string): boolean {
  if (label.length < 3 || label.length > 80) return false;
  if (/^(what to read next|where to go next|read next|next steps?|related(?: pages?| resources?| links?)?|on this page|in this article)$/i.test(label)) {
    return false;
  }
  return !/^(Documentation|Docs|Overview|Reference|API|Apis|Learn)$/i.test(label);
}

function countMarkdownLinks(text: string): number {
  return text.match(/\[[^\]\n]*\]\((?!#)[^)]+?\)/g)?.length ?? 0;
}

function countMarkdownHeadings(text: string): number {
  return text.match(/#{2,6}\s+/g)?.length ?? 0;
}

function isProjectSpecificHostOrPath(url: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  return isRepoSpecificHostOrPath(url, snapshot) || isOwnerSpecificHostOrPath(url, snapshot);
}

function isRepoSpecificHostOrPath(url: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  const repoCompact = compactText(snapshot.repo);
  const hostAndPath = compactText(`${url.hostname}${url.pathname}`);
  const primaryHostLabel = url.hostname.toLowerCase().replace(/^www\./, "").split(".").at(0) ?? "";
  const pathSegments = getPathSegments(url).map(compactText);
  const hasJavaScriptLangchainPath =
    repoCompact === "langchainjs" &&
    pathSegments.includes("javascript") &&
    pathSegments.includes("langchain");
  return (
    repoCompact.length >= 5 && hostAndPath.includes(repoCompact)
  ) || (
    repoCompact.length >= 3 && compactText(primaryHostLabel).startsWith(repoCompact)
  ) || (
    repoCompact.length >= 2 && compactText(primaryHostLabel) === repoCompact
  ) || (
    repoCompact.length >= 3 && pathSegments.includes(repoCompact)
  ) || (
    hasJavaScriptLangchainPath
  );
}

function isOwnerSpecificHostOrPath(url: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  const ownerCompact = compactText(snapshot.owner);
  const hostAndPath = compactText(`${url.hostname}${url.pathname}`);
  const primaryHostLabel = url.hostname.toLowerCase().replace(/^www\./, "").split(".").at(0) ?? "";
  return (
    ownerCompact.length >= 4 && hostAndPath.includes(ownerCompact)
  ) || (
    ownerCompact.length >= 4 && compactText(primaryHostLabel) === ownerCompact
  );
}

function isProjectSpecificPath(url: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  const repoCompact = compactText(snapshot.repo);
  const ownerCompact = compactText(snapshot.owner);
  const pathCompact = compactText(url.pathname);
  return (
    repoCompact.length >= 5 && pathCompact.includes(repoCompact)
  ) || (
    ownerCompact.length >= 4 && pathCompact.includes(ownerCompact)
  );
}

function isTopicSpecificHostOrPath(url: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  const hostAndPath = compactText(`${url.hostname}${url.pathname}`);
  const primaryHostLabel = compactText(url.hostname.toLowerCase().replace(/^www\./, "").split(".").at(0) ?? "");
  return getUsefulTopicKeywords(snapshot).some((topic) =>
    hostAndPath.includes(topic) ||
    primaryHostLabel === topic ||
    (topic.length >= 4 && primaryHostLabel.startsWith(topic)),
  );
}

function isRelatedToHomepageHost(url: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  if (snapshot.homepageUrl === undefined) return false;
  let homepage: URL;
  try {
    homepage = new URL(snapshot.homepageUrl);
  } catch {
    return false;
  }

  if (isSharedDeploymentHost(url.hostname) || isSharedDeploymentHost(homepage.hostname)) {
    return url.hostname.toLowerCase() === homepage.hostname.toLowerCase();
  }

  return getRegistrableHost(url.hostname) === getRegistrableHost(homepage.hostname);
}

function isSharedDeploymentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "vercel.app" ||
    normalized.endsWith(".vercel.app") ||
    normalized === "netlify.app" ||
    normalized.endsWith(".netlify.app") ||
    normalized === "pages.dev" ||
    normalized.endsWith(".pages.dev");
}

function isHomepageSpecificDocsSource(url: URL, snapshot: PreparedRepositoryWorkspace): boolean {
  if (snapshot.homepageUrl === undefined || !isRelatedToHomepageHost(url, snapshot)) return false;
  let homepage: URL;
  try {
    homepage = new URL(snapshot.homepageUrl);
  } catch {
    return false;
  }

  const homepageSegments = getPathSegments(homepage).map((segment) => segment.toLowerCase());
  if (homepageSegments.length === 0) return true;
  const sourceSegments = getPathSegments(url).map((segment) => segment.toLowerCase());
  return (
    isRepoSpecificHostOrPath(url, snapshot) ||
    sourceSegments.some((segment) => homepageSegments.includes(segment))
  );
}

function getRegistrableHost(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^www\./, "");
  const parts = normalized.split(".");
  if (parts.length <= 2) return normalized;
  return parts.slice(-2).join(".");
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasExactProjectMention(text: string, repoName: string): boolean {
  const escaped = repoName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function getMeaningfulDescriptionWords(description: string | undefined): string[] {
  if (description === undefined) return [];
  const stopWords = new Set([
    "and",
    "apps",
    "build",
    "building",
    "for",
    "framework",
    "javascript",
    "native",
    "node",
    "open",
    "platform",
    "project",
    "react",
    "server",
    "source",
    "the",
    "tool",
    "tools",
    "typescript",
    "web",
    "with",
  ]);
  return [...new Set(
    description
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 5 && !stopWords.has(word)),
  )].slice(0, 8);
}

function getUsefulTopicKeywords(snapshot: PreparedRepositoryWorkspace): string[] {
  const stopTopics = new Set([
    "api",
    "app",
    "apps",
    "cli",
    "code",
    "compiler",
    "css",
    "framework",
    "go",
    "golang",
    "html",
    "javascript",
    "language",
    "library",
    "node",
    "nodejs",
    "react",
    "server",
    "tool",
    "tools",
    "typescript",
    "web",
  ]);

  return [...new Set(
    (snapshot.topics ?? [])
      .map(compactText)
      .filter((topic) => topic.length >= 4 && !stopTopics.has(topic)),
  )].slice(0, 8);
}

function getRepositoryPathKeywords(snapshot: PreparedRepositoryWorkspace): string[] {
  const stopSegments = new Set([
    "assets",
    "bench",
    "benches",
    "build",
    "cmd",
    "common",
    "docs",
    "examples",
    "internal",
    "lib",
    "misc",
    "node_modules",
    "package",
    "packages",
    "pkg",
    "scripts",
    "src",
    "test",
    "tests",
    "tools",
    "vendor",
    "website",
  ]);
  const counts = new Map<string, number>();

  for (const file of snapshot.fileInventory) {
    const [segment] = file.path.split("/");
    if (segment === undefined) continue;
    const compact = compactText(segment);
    if (compact.length < 4 || stopSegments.has(compact)) continue;
    counts.set(compact, (counts.get(compact) ?? 0) + 1);
    if (compact.endsWith("er") && compact.length > 5) {
      counts.set(compact.slice(0, -2), (counts.get(compact.slice(0, -2)) ?? 0) + 1);
    }
  }

  for (const word of getMeaningfulDescriptionWords(snapshot.description)) {
    const compact = compactText(word);
    if (compact.length >= 5) counts.set(compact, (counts.get(compact) ?? 0) + 4);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([keyword]) => keyword)
    .slice(0, 16);
}
