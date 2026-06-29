import {
  failIndexJob,
  getIndexJob,
  setIndexJobPhase,
  touchIndexJob,
} from "@/lib/storage";
import { generateText, Output } from "ai";
import {
  getGitHubRepoSnapshot,
  readGitHubRepoFile,
  type PreparedRepositoryWorkspace,
} from "../github-repo.js";
import { getOpenWikiIndexModel } from "../model-config.js";
import { readIndexingContext } from "./context.js";
import { logIndexing } from "./log.js";
import {
  normalizeGeneratedOutline,
  normalizeGeneratedPageDrafts,
  normalizeOutlineNavigation,
  outlineGenerationSchema,
  pageGenerationSchema,
  type ParsedOutline,
  type ParsedOutlinePage,
  type ParsedPageDraft,
} from "./output.js";
import {
  discoverOfficialDocsIndex,
  readOfficialDocsPageSnippets,
  type OfficialDocsIndex,
} from "./official-docs.js";
import { completeIndexing } from "./publish.js";
import {
  createOutlinePrompt,
  createPageGenerationPrompt,
  createRepositoryMap,
} from "./prompt.js";
import {
  getMaxOutlinePagesForEvidence,
  getMinOutlinePagesForEvidence,
  getMinPageWordsForTarget,
} from "./quality-targets.js";
import { isInternalPlanningDocumentationPath } from "./source-paths.js";
import type { ContextSnippet, IndexAdapterState, OfficialDocsMetadata } from "./types.js";
import type { z } from "zod";

const DEFAULT_PAGE_WORKER_CONCURRENCY = 16;
const DEFAULT_OUTLINE_WORKER_TIMEOUT_MS = 6 * 60 * 1_000;
const DEFAULT_PAGE_WORKER_TIMEOUT_MS = 3 * 60 * 1_000;
const DEFAULT_OUTLINE_WORKER_MAX_OUTPUT_TOKENS = 32_768;
const DEFAULT_PAGE_WORKER_MAX_OUTPUT_TOKENS = 12_288;
const DEFAULT_WORKER_HEARTBEAT_MS = 30_000;
const MAX_OUTLINE_ATTEMPTS = 4;
const MAX_PAGE_ATTEMPTS = 3;
const MAX_PAGE_SOURCE_FILES = 12;
const MAX_PAGE_CONTEXT_CHARS = 8_000;
const MAX_REPORTED_PAGE_FAILURES = 6;

export type IndexRepositoryJobInput = {
  indexJobId: string;
  repositoryId: string;
  repoUrl: string;
  webUrl?: string;
};

export async function runIndexRepositoryJob(input: IndexRepositoryJobInput): Promise<void> {
  try {
    logIndexing("fetching-repository", {
      indexJobId: input.indexJobId,
      repositoryId: input.repositoryId,
      repoUrl: input.repoUrl,
    });
    await setIndexJobPhase({ indexJobId: input.indexJobId, phase: "fetching-repository" });
    const snapshot = await getGitHubRepoSnapshot(input.repoUrl);

    logIndexing(
      "reading-context",
      {
        indexJobId: input.indexJobId,
        repositoryId: input.repositoryId,
        repo: `${snapshot.owner}/${snapshot.repo}`,
      },
      {
        fileCount: snapshot.fileInventory.length,
        skippedFileCount: snapshot.skippedFiles.length,
      },
    );
    await setIndexJobPhase({ indexJobId: input.indexJobId, phase: "reading-context" });
    const contextSnippets = await readIndexingContext(snapshot);
    const officialDocsIndex = await discoverOfficialDocsIndex({
      contextSnippets,
      snapshot,
    });

    await startEveIndexingRun({
      ...input,
      contextSnippets,
      officialDocsIndex,
      snapshot,
    });
  } catch (error) {
    logIndexing(
      "failed",
      {
        indexJobId: input.indexJobId,
        repositoryId: input.repositoryId,
        repoUrl: input.repoUrl,
      },
      {
        error: error instanceof Error ? error.message : "Unknown indexing setup error.",
      },
    );
    await failIndexJob({
      errorMessage: error instanceof Error ? error.message : "Unknown indexing setup error.",
      indexJobId: input.indexJobId,
    });
  }
}

async function startEveIndexingRun(input: IndexRepositoryJobInput & {
  contextSnippets: ContextSnippet[];
  officialDocsIndex?: OfficialDocsIndex;
  snapshot: PreparedRepositoryWorkspace;
}): Promise<void> {
  const { contextSnippets, officialDocsIndex, snapshot } = input;

  logIndexing(
    "starting-eve-run",
    {
      indexJobId: input.indexJobId,
      repositoryId: input.repositoryId,
      repo: `${snapshot.owner}/${snapshot.repo}`,
    },
    {
      contextSnippetCount: contextSnippets.length,
      officialDocsIndexLinkCount: officialDocsIndex?.linkCount,
      officialDocsIndexUrl: officialDocsIndex?.sourceUrl,
    },
  );
  await setIndexJobPhase({ indexJobId: input.indexJobId, phase: "starting-eve-run" });

  const state: IndexAdapterState = {
    branch: snapshot.defaultBranch,
    commitSha: snapshot.commitSha,
    contextSnippets,
    fileInventory: snapshot.fileInventory,
    indexJobId: input.indexJobId,
    owner: snapshot.owner,
    repo: snapshot.repo,
    repositoryId: input.repositoryId,
    repoUrl: snapshot.url,
    officialDocs: summarizeOfficialDocsIndex(officialDocsIndex),
    skippedFiles: snapshot.skippedFiles,
    webUrl: input.webUrl,
    workspaceManifestPath: `${snapshot.workspacePath}/.openwiki/manifest.json`,
  };

  try {
    const repositoryMap = createRepositoryMap(snapshot.fileInventory);
    await setIndexJobPhase({ indexJobId: input.indexJobId, phase: "outlining-wiki" });
    logIndexing("outlining-wiki", state, {
      contextSnippetCount: contextSnippets.length,
    });
    await ensureIndexJobIsStillRunning(input.indexJobId);

    const documentationSourceCount = countDocumentationSourceFiles(snapshot.fileInventory);
    const outlineRun = await generateOutline({
      contextSnippets,
      documentationSourceCount,
      fileCount: snapshot.fileInventory.length,
      indexJobId: input.indexJobId,
      officialDocsIndex,
      snapshot,
      state,
    });

    let outline = outlineRun.outline;
    logIndexing("outlining-wiki", state, {
      eveSessionId: outlineRun.sessionId,
      pageCount: outline.pages.length,
    });

    await setIndexJobPhase({ indexJobId: input.indexJobId, phase: "generating-pages" });
    await ensureIndexJobIsStillRunning(input.indexJobId);
    const pages = await generatePages({
      ...input,
      documentationSourceCount,
      officialDocsIndex,
      outline,
      repositoryMap,
      state,
    });
    outline = pruneOutlineToGeneratedPages(outline, pages);

    const finalOutput = JSON.stringify({
      outline,
      pages,
      repositorySummary: outline.summary,
    });
    state.lastMessage = finalOutput;
    logIndexing("agent-response-received", state, {
      messageLength: finalOutput.length,
      pageCount: pages.length,
    });
    await setIndexJobPhase({
      indexJobId: state.indexJobId,
      phase: "agent-response-received",
    });
    logIndexing("turn-completed", state);
    await ensureIndexJobIsStillRunning(input.indexJobId);
    await completeIndexing(state);
  } catch (error) {
    if (state.published === true) return;
    const message = error instanceof Error ? error.message : "Unknown indexing error.";
    logIndexing(
      "failed",
      {
        indexJobId: input.indexJobId,
        repositoryId: input.repositoryId,
        repo: `${snapshot.owner}/${snapshot.repo}`,
      },
      {
        error: message,
      },
    );
    await failIndexJob({
      errorMessage: message,
      indexJobId: input.indexJobId,
    });
  }
}

function summarizeOfficialDocsIndex(index: OfficialDocsIndex | undefined): OfficialDocsMetadata | undefined {
  if (index === undefined) return undefined;

  return {
    discoveredFrom: index.discoveredFrom,
    entries: index.entries.slice(0, 240).map((entry) => ({
      group: entry.group,
      title: entry.title,
      url: entry.url,
    })),
    headingCount: index.headingCount,
    linkCount: index.linkCount,
    sourceUrl: index.sourceUrl,
  };
}

async function generateOutline(input: {
  contextSnippets: ContextSnippet[];
  documentationSourceCount: number;
  fileCount: number;
  indexJobId: string;
  officialDocsIndex?: OfficialDocsIndex;
  snapshot: PreparedRepositoryWorkspace;
  state: IndexAdapterState;
}): Promise<{
  outline: ParsedOutline;
  sessionId: string;
}> {
  let qualityFeedback: string | undefined;
  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= MAX_OUTLINE_ATTEMPTS; attempt += 1) {
    let parsedOutline: ParsedOutline;
    let responseId: string | undefined;
    try {
      const output = await runStructuredIndexingWorker({
        indexJobId: input.indexJobId,
        message: createOutlinePrompt({
          contextSnippets: input.contextSnippets,
          officialDocsIndex: input.officialDocsIndex,
          qualityFeedback,
          snapshot: input.snapshot,
        }),
        outputName: "openwiki_outline",
        phase: attempt === 1 ? "outline" : `outline:repair:${attempt}`,
        schema: outlineGenerationSchema,
        state: input.state,
        maxOutputTokens: DEFAULT_OUTLINE_WORKER_MAX_OUTPUT_TOKENS,
        timeoutMs: getOutlineWorkerTimeoutMs(),
      });
      parsedOutline = normalizeGeneratedOutline(output.output);
      responseId = output.responseId;
    } catch (error) {
      lastIssues = [`Outline worker did not return structured JSON: ${describeWorkerOutputError(error)}`];
      qualityFeedback = [
        lastIssues[0],
        "Return an object matching the requested outline schema with top-level title, summary, concepts, navigation, and pages.",
      ].join(" ");
      logIndexing("outlining-wiki", input.state, {
        attempt,
        outlineQualityIssues: lastIssues,
      });
      continue;
    }

    const outline = constrainOutlineForRepository({
      documentationSourceCount: input.documentationSourceCount,
      fileCount: input.fileCount,
      officialDocsLinkCount: input.officialDocsIndex?.linkCount,
      officialDocsIndex: input.officialDocsIndex,
      outline: parsedOutline,
      snapshot: input.snapshot,
      validPaths: new Set(input.snapshot.fileInventory.map((file) => file.path)),
    });
    const issues = getOutlineQualityIssues({
      documentationSourceCount: input.documentationSourceCount,
      fileCount: input.fileCount,
      officialDocsIndex: input.officialDocsIndex,
      officialDocsLinkCount: input.officialDocsIndex?.linkCount,
      outline,
      repoName: input.snapshot.repo,
    });

    if (issues.length === 0) {
      return {
        outline: normalizeOutlineNavigation(outline),
        sessionId: responseId ?? "structured",
      };
    }

    lastIssues = issues;
    qualityFeedback = issues.join(" ");
    logIndexing("outlining-wiki", input.state, {
      attempt,
      outlineQualityIssues: issues,
      pageCount: outline.pages.length,
    });
  }

  throw new Error(`Outline did not meet quality bar: ${lastIssues.join(" ")}`);
}

async function generatePages(input: IndexRepositoryJobInput & {
  contextSnippets: ContextSnippet[];
  documentationSourceCount: number;
  officialDocsIndex?: OfficialDocsIndex;
  outline: ParsedOutline;
  repositoryMap: string;
  snapshot: PreparedRepositoryWorkspace;
  state: IndexAdapterState;
}): Promise<ParsedPageDraft[]> {
  const pages: ParsedPageDraft[] = [];
  const failures: Array<{ error: string; slug: string }> = [];

  const concurrency = getPageWorkerConcurrency();
  const validSourcePaths = new Set(input.snapshot.fileInventory.map((file) => file.path));

  for (let start = 0; start < input.outline.pages.length; start += concurrency) {
    const batch = input.outline.pages.slice(start, start + concurrency);
    logIndexing("generating-pages", input.state, {
      batchEnd: start + batch.length,
      batchStart: start + 1,
      totalPages: input.outline.pages.length,
    });
    await setIndexJobPhase({ indexJobId: input.indexJobId, phase: "generating-pages" });
    await ensureIndexJobIsStillRunning(input.indexJobId);

    const drafts = await Promise.all(
      batch.map(async (page) => {
        const pageContext = await readPageContext({
          baselineContextSnippets: input.contextSnippets,
          page,
          snapshot: input.snapshot,
        });
        const officialDocsSnippets = await readOfficialDocsPageSnippets({
          officialDocsIndex: input.officialDocsIndex,
          page,
        });
        try {
          return await generatePageDraft({
            contextSnippets: pageContext,
            documentationSourceCount: input.documentationSourceCount,
            fileCount: input.snapshot.fileInventory.length,
            indexJobId: input.indexJobId,
            officialDocsLinkCount: input.officialDocsIndex?.linkCount,
            officialDocsSnippets,
            outline: input.outline,
            page,
            repository: {
              commitSha: input.snapshot.commitSha,
              defaultBranch: input.snapshot.defaultBranch,
              fullName: `${input.snapshot.owner}/${input.snapshot.repo}`,
              url: input.snapshot.url,
            },
            repositoryMap: input.repositoryMap,
            state: input.state,
            validSourcePaths,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown page generation error.";
          logIndexing("generating-pages", input.state, {
            error: message,
            skippedPageSlug: page.slug,
          });
          failures.push({
            error: message,
            slug: page.slug,
          });
          return null;
        }
      }),
    );

    pages.push(...drafts.filter((draft): draft is ParsedPageDraft => draft !== null));
  }

  if (failures.length > 0) {
    const minimumPublishablePages = getMinimumPublishablePageCount(input.outline.pages.length);
    if (pages.length < minimumPublishablePages) {
      const reported = failures
        .slice(0, MAX_REPORTED_PAGE_FAILURES)
        .map((failure) => `${failure.slug}: ${failure.error}`)
        .join("; ");
      const suffix = failures.length > MAX_REPORTED_PAGE_FAILURES
        ? `; ${failures.length - MAX_REPORTED_PAGE_FAILURES} more page(s) failed`
        : "";
      throw new Error(`Some wiki pages did not meet the quality bar: ${reported}${suffix}`);
    }

    logIndexing("generating-pages", input.state, {
      generatedPageCount: pages.length,
      skippedPageCount: failures.length,
      skippedPageSlugs: failures.map((failure) => failure.slug).slice(0, MAX_REPORTED_PAGE_FAILURES),
    });
  }

  const cleanedPages = filterRelatedPagesToGeneratedPages(pages);
  const missingPageSlugs = getMissingGeneratedPageSlugs(input.outline.pages, cleanedPages);
  if (missingPageSlugs.length > 0 && cleanedPages.length < getMinimumPublishablePageCount(input.outline.pages.length)) {
    throw new Error(`Page generation completed without required pages: ${missingPageSlugs.join(", ")}`);
  }

  if (cleanedPages.length === 0) {
    throw new Error("No page workers returned publishable wiki pages.");
  }

  return cleanedPages;
}

function getMinimumPublishablePageCount(outlinePageCount: number): number {
  if (outlinePageCount <= 3) return outlinePageCount;
  if (outlinePageCount >= 50) return Math.max(48, Math.floor(outlinePageCount * 0.9));
  if (outlinePageCount >= 25) return Math.max(20, Math.floor(outlinePageCount * 0.75));
  return Math.max(3, Math.floor(outlinePageCount * 0.6));
}

async function generatePageDraft(input: {
  contextSnippets: ContextSnippet[];
  documentationSourceCount: number;
  fileCount: number;
  indexJobId: string;
  officialDocsLinkCount?: number;
  officialDocsSnippets: ContextSnippet[];
  outline: ParsedOutline;
  page: ParsedOutlinePage;
  repository: {
    commitSha: string;
    defaultBranch: string;
    fullName: string;
    url: string;
  };
  repositoryMap: string;
  state: IndexAdapterState;
  validSourcePaths: Set<string>;
}): Promise<ParsedPageDraft> {
  let previousDrafts: ParsedPageDraft[] | undefined;
  let qualityFeedback: string | undefined;
  let lastIssues: string[] = [];
  let fallbackDraft: ParsedPageDraft | undefined;
  const minimumWordCount = getMinPageWordsForTarget({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsLinkCount: input.officialDocsLinkCount,
    page: input.page,
  });

  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt += 1) {
    let parsed: ParsedPageDraft[];
    try {
      const output = await runStructuredIndexingWorker({
        indexJobId: input.indexJobId,
        message: createPageGenerationPrompt({
          contextSnippets: input.contextSnippets,
          minimumWordCount,
          officialDocsSnippets: input.officialDocsSnippets,
          outline: input.outline,
          pages: [input.page],
          previousDrafts,
          qualityFeedback,
          repository: input.repository,
          repositoryMap: input.repositoryMap,
        }),
        outputName: "openwiki_pages",
        phase: attempt === 1 ? `page:${input.page.slug}` : `page:${input.page.slug}:repair:${attempt}`,
        schema: pageGenerationSchema,
        state: input.state,
        maxOutputTokens: DEFAULT_PAGE_WORKER_MAX_OUTPUT_TOKENS,
        timeoutMs: getPageWorkerTimeoutMs(),
      });
      parsed = normalizeGeneratedPageDrafts(output.output);
    } catch (error) {
      lastIssues = [`Page worker did not return structured JSON: ${describeWorkerOutputError(error)}`];
      qualityFeedback = [
        lastIssues[0],
        "Return an object with a pages array. Use markdownLines as an array of plain JSON strings.",
      ].join(" ");
      logIndexing("generating-pages", input.state, {
        attempt,
        pageQualityIssues: lastIssues,
        slug: input.page.slug,
      });
      continue;
    }
    const draft = parsed.find(
      (candidate) => normalizeSlugForComparison(candidate.slug) === normalizeSlugForComparison(input.page.slug),
    );
    if (draft === undefined) {
      throw new Error(`Page worker for "${input.page.slug}" did not return that page.`);
    }

    const issues = getPageQualityIssues({
      documentationSourceCount: input.documentationSourceCount,
      draft,
      fileCount: input.fileCount,
      officialDocsLinkCount: input.officialDocsLinkCount,
      page: input.page,
      validSourcePaths: input.validSourcePaths,
    });
    if (issues.length === 0) {
      return draft;
    }

    lastIssues = issues;
    if (canPublishFocusedFallbackDraft({
      draft,
      issues,
      page: input.page,
      validSourcePaths: input.validSourcePaths,
    })) {
      fallbackDraft = draft;
    }
    const rejectedWordCount = getApproximateRejectedWordCount(issues);
    previousDrafts = rejectedWordCount !== null && rejectedWordCount < Math.floor(minimumWordCount * 0.65)
      ? undefined
      : [draft];
    qualityFeedback = createPageRepairFeedback({
      issues,
      minimumWordCount,
    });
    logIndexing("generating-pages", input.state, {
      attempt,
      pageQualityIssues: issues,
      slug: input.page.slug,
    });
  }

  if (fallbackDraft !== undefined) {
    logIndexing("generating-pages", input.state, {
      acceptedWithWarnings: true,
      pageQualityIssues: lastIssues,
      slug: input.page.slug,
    });
    return fallbackDraft;
  }

  throw new Error(`Page "${input.page.slug}" did not meet quality bar: ${lastIssues.join(" ")}`);
}

function filterRelatedPagesToGeneratedPages(pages: ParsedPageDraft[]): ParsedPageDraft[] {
  const generatedSlugs = new Set(pages.map((page) => normalizeSlugForComparison(page.slug)));
  return pages.map((page) => ({
    ...page,
    relatedPages: page.relatedPages.filter((slug) => generatedSlugs.has(normalizeSlugForComparison(slug))),
  }));
}

function describeWorkerOutputError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown worker output error.";
}

function createPageRepairFeedback(input: {
  issues: string[];
  minimumWordCount: number;
}): string {
  const feedback = [input.issues.join(" ")];
  const missingVisibleSourcePaths = input.issues.flatMap((issue) => {
    const match = issue.match(/^Mention important source path (.+) in the page prose or source list\.$/);
    return match === null ? [] : [match[1]];
  });
  const unrelatedSourcePaths = input.issues.flatMap((issue) => {
    const match = issue.match(/^Remove unrelated source path (.+) from page prose, Relevant Source Files, Sources lines, and citations\.$/);
    return match === null ? [] : [match[1]];
  });

  if (missingVisibleSourcePaths.length > 0) {
    const sourceBullets = missingVisibleSourcePaths
      .map((path) => `- \`${path}\`: explain why this file matters for this page.`)
      .join(" ");
    feedback.push(
      [
        "The next draft must copy these repository paths exactly into the `## Relevant Source Files` section and at least one visible `Sources:` line.",
        `Add bullets like: ${sourceBullets}`,
        `Add or update a visible line like: Sources: ${missingVisibleSourcePaths.join(", ")}`,
        "Do not shorten, rename, wrap, or paraphrase these paths.",
      ].join(" "),
    );
  }

  if (unrelatedSourcePaths.length > 0) {
    feedback.push(
      [
        `Remove these unrelated repository paths entirely: ${unrelatedSourcePaths.join(", ")}.`,
        "Do not include them in the `## Relevant Source Files` section, visible `Sources:` lines, prose, or structured citations.",
        "Use only the requested page sourcePaths and source-backed snippets that directly match this page's reader task.",
      ].join(" "),
    );
  }

  if (input.issues.some((issue) => /\bwords?\b/i.test(issue))) {
    const currentWordCount = getApproximateRejectedWordCount(input.issues);
    const proseDeficit = currentWordCount === null
      ? null
      : Math.max(0, input.minimumWordCount - currentWordCount);
    const requestedNewWords = proseDeficit === null
      ? 500
      : Math.max(500, proseDeficit + 150);
    feedback.push(
      [
        `The validator excludes fenced code blocks, inline code, URLs, source path strings, visible Sources lines, JSON syntax, and citation metadata from the substantive prose word count; the next draft must contain at least ${input.minimumWordCount} prose words outside those excluded regions.`,
        currentWordCount === null
          ? "Add 350-500 genuinely new prose words over the rejected draft for small deficits, and add more when the rejected draft is far below target."
          : `The rejected draft only had about ${currentWordCount} counted prose words, so add at least ${requestedNewWords} genuinely new counted prose words over that draft.`,
        currentWordCount !== null && currentWordCount < Math.floor(input.minimumWordCount * 0.65)
          ? "Because the rejected draft is far below target, rewrite the page from the supplied evidence instead of preserving its compact structure."
          : "Keep the existing useful structure, but expand every short section into source-backed explanatory prose.",
        "Expand task flow, source-to-code mapping, API/config details, edge cases, examples, and related-page guidance in normal paragraphs.",
        input.minimumWordCount <= 700
          ? "For this compact page, include at least five normal narrative paragraphs of 70-110 words each outside lists, tables, code, source path bullets, citations, and visible Sources lines."
          : "For this page, include enough normal narrative paragraphs that the prose remains substantial after lists, tables, code, path bullets, citations, and visible Sources lines are removed.",
        "Do not merely rephrase the same compact sections; add complete 60-120 word paragraphs or useful subsections while keeping the page bounded.",
      ].join(" "),
    );
  }
  if (input.issues.some((issue) => /Reference-like pages need concrete API\/config\/command detail/i.test(issue))) {
    feedback.push(
      [
        "The next draft must include a compact concrete reference section, not only prose.",
        "Use a markdown table or bullets that name real routes, exported functions, config keys, command names, options, schemas, or types from the supplied evidence.",
        "If the exact signature is not visible, describe the source-level contract conservatively and cite the files that define it.",
      ].join(" "),
    );
  }
  if (input.issues.some((issue) => /Guide-like pages need a concrete source-backed example/i.test(issue))) {
    feedback.push(
      [
        "The next draft must include at least one concrete guide artifact from the supplied evidence.",
        "Use a numbered workflow, command, config fragment, code block, route example, or file path sequence that a reader could follow.",
        "Keep the example source-backed and cite the repository paths that provide it.",
      ].join(" "),
    );
  }
  if (input.issues.some((issue) => /## sections/i.test(issue))) {
    feedback.push(
      [
        "Add useful `##` sections rather than padding existing sections.",
        "Good docs-rich page sections include Purpose and Scope, Reader Workflow, System-to-Code Mapping, API or Configuration Details, Implementation Notes, Testing Signals, Troubleshooting, and Related Pages when supported by evidence.",
        "Each added section should contain substantive source-grounded prose, not only a table or path list.",
      ].join(" "),
    );
  }
  return feedback.join(" ");
}

function getApproximateRejectedWordCount(issues: string[]): number | null {
  for (const issue of issues) {
    const match = issue.match(/page has about (\d+) words/i);
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  }
  return null;
}

function constrainOutlineForRepository(input: {
  documentationSourceCount: number;
  fileCount: number;
  officialDocsLinkCount?: number;
  officialDocsIndex?: OfficialDocsIndex;
  outline: ParsedOutline;
  snapshot: PreparedRepositoryWorkspace;
  validPaths: Set<string>;
}): ParsedOutline {
  const maxPages = getMaxOutlinePagesForEvidence({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsLinkCount: input.officialDocsLinkCount,
  });
  const minPages = getMinOutlinePagesForEvidence({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsLinkCount: input.officialDocsLinkCount,
  });
  const targetPageCount = Math.min(maxPages, Math.max(minPages, input.outline.pages.length));
  const officialDocsNormalizedOutline = normalizeOfficialDocsOutline({
    officialDocsIndex: input.officialDocsIndex,
    outline: input.outline,
  });
  const expandedOutline = expandOutlineWithOfficialDocs({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsIndex: input.officialDocsIndex,
    outline: officialDocsNormalizedOutline,
    snapshot: input.snapshot,
    targetPageCount,
  });
  const normalizedExpandedOutline = normalizeOfficialDocsOutline({
    officialDocsIndex: input.officialDocsIndex,
    outline: expandedOutline,
  });
  const refilledOutline = expandOutlineWithOfficialDocs({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsIndex: input.officialDocsIndex,
    outline: normalizedExpandedOutline,
    snapshot: input.snapshot,
    targetPageCount,
  });
  const finalOfficialDocsOutline = normalizeOfficialDocsOutline({
    officialDocsIndex: input.officialDocsIndex,
    outline: refilledOutline,
  });
  const primitiveCompleteOutline = ensureAgentFrameworkPrimitivePages({
    officialDocsIndex: input.officialDocsIndex,
    outline: finalOfficialDocsOutline,
    snapshot: input.snapshot,
  });
  const navigationNormalizedOutline = normalizeOfficialDocsNavigation({
    documentationSourceCount: input.documentationSourceCount,
    officialDocsIndex: input.officialDocsIndex,
    officialDocsLinkCount: input.officialDocsLinkCount,
    outline: primitiveCompleteOutline,
  });
  const retargetedOutline = retargetOfficialDocsOutlineSourcePaths({
    officialDocsIndex: input.officialDocsIndex,
    outline: navigationNormalizedOutline,
    snapshot: input.snapshot,
  });
  const outline = normalizeOutlineNavigation(normalizeOutlineSourcePaths({
    outline: retargetedOutline,
    validPaths: input.validPaths,
  }));
  if (outline.pages.length <= maxPages) return outline;

  const selectedPages = [...outline.pages]
    .map((page, index) => ({ index, page }))
    .sort((a, b) => {
      const overviewDelta = Number(isOverviewPage(b.page)) - Number(isOverviewPage(a.page));
      if (overviewDelta !== 0) return overviewDelta;

      const priorityDelta = getPriorityRank(b.page.priority) - getPriorityRank(a.page.priority);
      if (priorityDelta !== 0) return priorityDelta;

      return a.index - b.index;
    })
    .slice(0, maxPages)
    .sort((a, b) => a.index - b.index)
    .map(({ page }) => page);
  const selectedSlugs = new Set(selectedPages.map((page) => normalizeSlugForComparison(page.slug)));

  return normalizeOutlineNavigation({
    ...outline,
    navigation: pruneNavigation(outline.navigation, selectedSlugs),
    pages: selectedPages,
  });
}

function retargetOfficialDocsOutlineSourcePaths(input: {
  officialDocsIndex?: OfficialDocsIndex;
  outline: ParsedOutline;
  snapshot: PreparedRepositoryWorkspace;
}): ParsedOutline {
  const { officialDocsIndex } = input;
  if (officialDocsIndex === undefined || officialDocsIndex.entries.length === 0) {
    return input.outline;
  }

  return {
    ...input.outline,
    pages: input.outline.pages.map((page) => {
      const entry = findOfficialDocsEntryForOutlinePage(page, officialDocsIndex);
      if (entry === undefined) return page;

      const sourcePaths = selectSourcePathsForOfficialDocsEntry({
        entry,
        snapshot: input.snapshot,
      });
      if (sourcePaths.length === 0) return page;

      return {
        ...page,
        sourcePaths,
      };
    }),
  };
}

function normalizeOfficialDocsOutline(input: {
  officialDocsIndex?: OfficialDocsIndex;
  outline: ParsedOutline;
}): ParsedOutline {
  const { officialDocsIndex } = input;
  if (officialDocsIndex === undefined || officialDocsIndex.entries.length === 0) {
    return input.outline;
  }

  const usedSlugs = new Set(input.outline.pages.map((page) => normalizeSlugForComparison(page.slug)));
  const replacements = new Map<string, { slug: string; title: string }>();
  const pages = input.outline.pages.map((page) => {
    const entry = findOfficialDocsEntryForOutlinePage(page, officialDocsIndex);
    if (entry === undefined) return page;

    const namespace = getOfficialDocsUrlNamespace(entry.url);
    const currentSlug = normalizeSlugForComparison(page.slug);
    usedSlugs.delete(currentSlug);
    let slug = getSimplifiedOfficialDocsPageSlug({
      currentSlug,
      entry,
      usedSlugs,
    }) ?? currentSlug;
    let title = page.title;

    if (isGenericOfficialDocsTitle(page.title)) {
      title = createQualifiedOfficialDocsTitle({
        entry,
        title: page.title,
      });
    }

    if (namespace !== undefined && namespace !== "react" && !currentSlug.includes(namespace)) {
      slug = createOfficialDocsPageSlug(entry, usedSlugs);
    }
    title = normalizeNoisyOfficialDocsOutlineTitle({ slug, title });
    usedSlugs.add(slug);

    if (slug === currentSlug && title === page.title) return page;

    replacements.set(currentSlug, { slug, title });

    return {
      ...page,
      purpose: namespace === undefined || page.purpose.includes(namespace)
        ? page.purpose
        : `${page.purpose} This page covers the ${namespace} official docs namespace.`,
      slug,
      title,
    };
  });

  const redundantSlugs = new Set(
    [
      ...getRedundantOfficialDocsTopicPages(pages),
      ...getRedundantSetupLandingPages(pages),
    ].map((page) => normalizeSlugForComparison(page.slug)),
  );
  const selectedPages = pages.filter((page) => !redundantSlugs.has(normalizeSlugForComparison(page.slug)));
  const selectedSlugs = new Set(selectedPages.map((page) => normalizeSlugForComparison(page.slug)));

  return {
    ...input.outline,
    navigation: pruneNavigation(
      rewriteNavigationSlugs(input.outline.navigation, replacements),
      selectedSlugs,
    ),
    pages: selectedPages,
  };
}

function normalizeNoisyOfficialDocsOutlineTitle(input: {
  slug: string;
  title: string;
}): string {
  const title = input.title
    .replace(/\b(?:What To Read Next|Where To Go Next|Read Next|Next Steps?)\b\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length === 0) return input.title;

  const slug = normalizeSlugForComparison(input.slug);
  if (/^(getting-started|quickstart|quick-start|installation|setup)$/.test(slug) && /getting started|quickstart|quick start|installation|setup/i.test(title)) {
    return titleFromSlug(slug);
  }

  return title;
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => {
      if (/^(api|cli|css|dom|html|jsx|mcp|mdx|openapi|sdk|ui|url)$/i.test(word)) {
        return word.toUpperCase();
      }
      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function getSimplifiedOfficialDocsPageSlug(input: {
  currentSlug: string;
  entry: OfficialDocsIndex["entries"][number];
  usedSlugs: Set<string>;
}): string | undefined {
  const titleKey = normalizeSlugForComparison(input.entry.title);
  const urlSlug = getOfficialDocsEntryUrlSlug(input.entry.url);
  const namespace = getOfficialDocsUrlNamespace(input.entry.url);
  const hasRepeatedTitle = titleKey.length > 0 && input.currentSlug.includes(`${titleKey}-${titleKey}`);
  const hasRepeatedUrlSlug = urlSlug !== undefined && input.currentSlug.includes(`${urlSlug}-${urlSlug}`);
  if (!hasRepeatedTitle && !hasRepeatedUrlSlug) return undefined;

  const candidates: string[] = [];
  if (hasRepeatedUrlSlug && urlSlug !== undefined) {
    candidates.push(urlSlug);
  }
  if (hasRepeatedTitle) {
    candidates.push(input.currentSlug.replace(`${titleKey}-${titleKey}`, titleKey));
  }
  if (hasRepeatedUrlSlug && urlSlug !== undefined) {
    candidates.push(input.currentSlug.replace(`${urlSlug}-${urlSlug}`, urlSlug));
  }
  if (isGenericOfficialDocsTitle(input.entry.title) && namespace !== undefined && titleKey.length > 0) {
    candidates.push(normalizeSlugForComparison(`${namespace}-${titleKey}`));
    const namespaceTail = namespace.split("-").at(-1);
    if (namespaceTail !== undefined && titleKey.startsWith(`${namespaceTail}-`)) {
      candidates.push(normalizeSlugForComparison(`${namespace}-${titleKey.slice(namespaceTail.length + 1)}`));
    }
  }
  if (urlSlug !== undefined) candidates.push(urlSlug);
  if (titleKey.length > 0) candidates.push(titleKey);

  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index).find((candidate) =>
    candidate.length > 0 && !input.usedSlugs.has(candidate)
  );
}

function createQualifiedOfficialDocsTitle(input: {
  entry: OfficialDocsIndex["entries"][number];
  title: string;
}): string {
  const qualifier = getOfficialDocsTitleQualifier(input.entry);
  if (qualifier === undefined) return input.title;

  const titleKey = normalizeSlugForComparison(input.title);
  const qualifierKey = normalizeSlugForComparison(qualifier);
  if (titleKey.startsWith(qualifierKey)) return input.title;
  return `${qualifier} ${input.title}`;
}

function getOfficialDocsTitleQualifier(entry: OfficialDocsIndex["entries"][number]): string | undefined {
  const namespace = getOfficialDocsUrlNamespace(entry.url);
  if (namespace !== undefined) {
    if (namespace !== "react") return cleanNavigationTitle(namespace.replace(/[-_]+/g, " "));

    const groupQualifier = getOfficialDocsGroupTitleQualifier(entry.group);
    return groupQualifier ?? "React";
  }

  return getOfficialDocsGroupTitleQualifier(entry.group);
}

function getOfficialDocsGroupTitleQualifier(group: string | undefined): string | undefined {
  const groupParts = group
    ?.split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !/^(api reference|apis?|docs?|documentation|learn|reference)$/i.test(part)) ?? [];
  const qualifier = groupParts.at(-1);
  return qualifier === undefined ? undefined : cleanNavigationTitle(qualifier.replace(/[-_]+/g, " "));
}

function rewriteNavigationSlugs(
  nodes: ParsedOutline["navigation"],
  replacements: Map<string, { slug: string; title: string }>,
): ParsedOutline["navigation"] {
  if (replacements.size === 0) return nodes;

  return nodes.map((node) => {
    const slug = node.slug === undefined ? undefined : normalizeSlugForComparison(node.slug);
    const replacement = slug === undefined ? undefined : replacements.get(slug);
    const children = node.children === undefined
      ? undefined
      : rewriteNavigationSlugs(node.children, replacements);

    return {
      ...node,
      ...(children === undefined ? {} : { children }),
      ...(replacement === undefined ? {} : { slug: replacement.slug, title: replacement.title }),
    };
  });
}

function normalizeOfficialDocsNavigation(input: {
  documentationSourceCount: number;
  officialDocsIndex?: OfficialDocsIndex;
  officialDocsLinkCount?: number;
  outline: ParsedOutline;
}): ParsedOutline {
  const { officialDocsIndex, outline } = input;
  const agentFrameworkNavigation = buildAgentFrameworkNavigationIfSupported({
    officialDocsIndex,
    pages: outline.pages,
  });
  if (agentFrameworkNavigation !== undefined) {
    return {
      ...outline,
      navigation: agentFrameworkNavigation,
    };
  }

  if (officialDocsIndex === undefined || officialDocsIndex.linkCount < 80 || outline.pages.length < 18) {
    return outline;
  }

  const docsRich = input.documentationSourceCount >= 80 || (input.officialDocsLinkCount ?? 0) >= 80;
  if (!docsRich) return outline;

  const stats = getNavigationStats(outline.navigation);
  if (stats.maxDepth >= 2 && !isSingleWrapperNavigation(outline.navigation, outline.pages.length)) {
    return outline;
  }

  const navigation = buildOfficialDocsNavigation({
    officialDocsIndex,
    pages: outline.pages,
  });
  if (navigation.length === 0) return outline;

  return {
    ...outline,
    navigation,
  };
}

function buildOfficialDocsNavigation(input: {
  officialDocsIndex: OfficialDocsIndex;
  pages: ParsedOutlinePage[];
}): ParsedOutline["navigation"] {
  const roots = new Map<string, ParsedOutline["navigation"][number]>();
  const fallbackRoot = getOrCreateNavigationFolder(roots, "Additional Topics");

  for (const page of input.pages) {
    const leaf = {
      slug: page.slug,
      title: page.title,
    };
    if (isOverviewPage(page)) {
      const start = getOrCreateNavigationFolder(roots, "Start Here");
      start.children = [...(start.children ?? []), leaf];
      continue;
    }

    const entry = findOfficialDocsEntryForOutlinePage(page, input.officialDocsIndex);
    if (entry === undefined) {
      fallbackRoot.children = [...(fallbackRoot.children ?? []), leaf];
      continue;
    }

    const [rootTitle = "Official Docs", secondTitle, thirdTitle] = getOfficialDocsNavigationGroupParts(entry);
    const root = getOrCreateNavigationFolder(roots, rootTitle);
    if (secondTitle === undefined) {
      root.children = [...(root.children ?? []), leaf];
      continue;
    }

    const second = getOrCreateChildFolder(root, secondTitle);
    if (thirdTitle === undefined) {
      second.children = [...(second.children ?? []), leaf];
      continue;
    }

    const third = getOrCreateChildFolder(second, thirdTitle);
    third.children = [...(third.children ?? []), leaf];
  }

  if ((fallbackRoot.children?.length ?? 0) === 0) {
    roots.delete("Additional Topics");
  }

  return [...roots.values()].filter((node) => (node.children?.length ?? 0) > 0);
}

function buildAgentFrameworkNavigationIfSupported(input: {
  officialDocsIndex?: OfficialDocsIndex;
  pages: ParsedOutlinePage[];
}): ParsedOutline["navigation"] | undefined {
  const { officialDocsIndex, pages } = input;
  if (officialDocsIndex === undefined || pages.length < 18) return undefined;
  if (!isAgentFrameworkDocsIndex(officialDocsIndex)) return undefined;

  const navigation = buildAgentFrameworkNavigation(pages);
  const stats = getNavigationStats(navigation);
  if (stats.rootFolderCount < 4 || stats.leafCount < Math.floor(pages.length * 0.8)) {
    return undefined;
  }

  return navigation;
}

function isAgentFrameworkDocsIndex(
  officialDocsIndex: OfficialDocsIndex | undefined,
): officialDocsIndex is OfficialDocsIndex {
  return officialDocsIndex !== undefined && getAgentFrameworkPrimitiveFamilies(officialDocsIndex).length >= 8;
}

function buildAgentFrameworkNavigation(pages: ParsedOutlinePage[]): ParsedOutline["navigation"] {
  const remaining = new Map(pages.map((page) => [normalizeSlugForComparison(page.slug), page]));
  const navigation: ParsedOutline["navigation"] = [];

  for (const group of AGENT_FRAMEWORK_NAV_GROUPS) {
    const children = pages
      .filter((page) => remaining.has(normalizeSlugForComparison(page.slug)) && group.test(page))
      .map((page) => ({
        slug: page.slug,
        title: page.title,
      }));

    if (children.length < 2) continue;

    navigation.push({
      children,
      title: group.title,
    });
    for (const child of children) {
      if (child.slug !== undefined) remaining.delete(normalizeSlugForComparison(child.slug));
    }
  }

  const remainingLeaves = pages
    .filter((page) => remaining.has(normalizeSlugForComparison(page.slug)))
    .map((page) => ({
      slug: page.slug,
      title: page.title,
    }));

  if (remainingLeaves.length > 0) {
    const operations = navigation.find((node) => node.title === "Deployment and Reference");
    if (operations !== undefined) {
      operations.children = [...(operations.children ?? []), ...remainingLeaves];
    } else {
      navigation.push({
        children: remainingLeaves,
        title: "Reference and Operations",
      });
    }
  }

  return navigation;
}

const AGENT_FRAMEWORK_NAV_GROUPS: Array<{
  test: (page: ParsedOutlinePage) => boolean;
  title: string;
}> = [
  {
    title: "Start Here",
    test: (page) => isOverviewPage(page) || agentPageMatches(page, [
      /\bgetting started\b/,
      /\bquick ?start\b/,
      /\binstallation\b/,
      /\bintroduction\b/,
    ]),
  },
  {
    title: "Tutorials",
    test: (page) => agentPageMatches(page, [
      /\btutorials?\b/,
      /\bfirst agent\b/,
      /\bsample data\b/,
      /\bwarehouse\b/,
      /\banalysis\b/,
      /\bplaybooks?\b/,
      /\bship it\b/,
      /\bguard\b/,
    ]),
  },
  {
    title: "Core Concepts",
    test: (page) => agentPageMatches(page, [
      /\bconcepts?\b/,
      /\bexecution model\b/,
      /\bdurability\b/,
      /\bsessions?\b/,
      /\bruns?\b/,
      /\bstreaming\b/,
      /\bcontext control\b/,
      /\bsecurity\b/,
      /\bdefault harness\b/,
    ]),
  },
  {
    title: "Authoring Agents",
    test: (page) => agentPageMatches(page, [
      /\bagent config(?:uration)?\b/,
      /\bproject layout\b/,
      /\bfilesystem\b/,
      /\binstructions?\b/,
      /\bskills?\b/,
      /\btools?\b/,
      /\bapprovals?\b/,
      /\bhuman in the loop\b/,
      /\bsandbox\b/,
      /\bdefineagent\b/,
      /\bdefine tool\b/,
    ]),
  },
  {
    title: "Runtime Capabilities",
    test: (page) =>
      agentPageMatches(page, [
        /\bdynamic\b/,
        /\bworkflows?\b/,
        /\bhooks?\b/,
        /\bschedules?\b/,
        /\bsubagents?\b/,
        /\bremote agents?\b/,
        /\bstate\b/,
      ]) &&
      !agentPageMatches(page, [
        /\bclient\b/,
        /\bfrontend\b/,
        /\bui\b/,
      ]),
  },
  {
    title: "Channels and Clients",
    test: (page) => agentPageMatches(page, [
      /\bchannels?\b/,
      /\beve channel\b/,
      /\bcustom channel\b/,
      /\bslack\b/,
      /\bdiscord\b/,
      /\bgithub\b/,
      /\blinear\b/,
      /\bteams\b/,
      /\btelegram\b/,
      /\btwilio\b/,
      /\bfrontend\b/,
      /\bclient sdk\b/,
      /\bcontinuations?\b/,
      /\bmessages?\b/,
      /\boutput schema\b/,
      /\bnextjs\b/,
      /\bnuxt\b/,
      /\bsveltekit\b/,
      /\bvue\b/,
      /\buse eve\b/,
    ]),
  },
  {
    title: "Connections",
    test: (page) => agentPageMatches(page, [
      /\bconnections?\b/,
      /\bmcp\b/,
      /\bopenapi\b/,
      /\bopen api\b/,
      /\boauth\b/,
      /\bvercel connect\b/,
    ]),
  },
  {
    title: "Evals and Observability",
    test: (page) => agentPageMatches(page, [
      /\bevals?\b/,
      /\bevaluations?\b/,
      /\bassertions?\b/,
      /\bjudges?\b/,
      /\breporters?\b/,
      /\btargets?\b/,
      /\binstrumentation\b/,
      /\bobservability\b/,
      /\btelemetry\b/,
    ]),
  },
  {
    title: "Deployment and Reference",
    test: (page) => agentPageMatches(page, [
      /\bdeployment\b/,
      /\bdeploy\b/,
      /\bauth\b/,
      /\broute protection\b/,
      /\blocal development\b/,
      /\bterminal ui\b/,
      /\bdev tui\b/,
      /\bcli\b/,
      /\bcommands?\b/,
      /\btypescript api\b/,
      /\bapi reference\b/,
      /\breference\b/,
    ]),
  },
];

function agentPageMatches(page: ParsedOutlinePage, patterns: RegExp[]): boolean {
  const text = [
    page.slug,
    page.title,
  ]
    .map(normalizeSlugForComparison)
    .join(" ")
    .replace(/-/g, " ");

  return patterns.some((pattern) => pattern.test(text));
}

function findOfficialDocsEntryForOutlinePage(
  page: ParsedOutlinePage,
  index: OfficialDocsIndex,
): OfficialDocsIndex["entries"][number] | undefined {
  const scored = index.entries
    .map((entry) => ({
      entry,
      score: scoreOfficialDocsEntryForOutlinePage(page, entry),
    }))
    .filter((item) => item.score >= 35)
    .sort((a, b) => b.score - a.score || a.entry.url.localeCompare(b.entry.url));

  return scored[0]?.entry;
}

function scoreOfficialDocsEntryForOutlinePage(
  page: ParsedOutlinePage,
  entry: OfficialDocsIndex["entries"][number],
): number {
  const slug = normalizeSlugForComparison(page.slug);
  const title = normalizeSlugForComparison(page.title);
  const purpose = normalizeSlugForComparison(page.purpose);
  const entryTitle = normalizeSlugForComparison(entry.title);
  const entryGroup = normalizeSlugForComparison(entry.group ?? "");
  const entryUrlSlug = getOfficialDocsEntryUrlSlug(entry.url);
  const entryNamespace = getOfficialDocsUrlNamespace(entry.url);
  const searchablePage = `${slug} ${title} ${purpose}`;
  const sectionOverviewTopic = getOfficialDocsSectionOverviewTopic({ slug, title });

  if (slug === "overview" && title.includes("overview")) {
    return 0;
  }
  if (
    sectionOverviewTopic !== undefined &&
    isGenericOfficialDocsTitle(entry.title) &&
    !officialDocsEntryMentionsTopic(entry, sectionOverviewTopic)
  ) {
    return 0;
  }

  let score = 0;
  if (entryTitle.length > 0) {
    if (title === entryTitle) score += isGenericOfficialDocsTitle(entryTitle) ? 8 : 36;
    if (slug === entryTitle) score += 34;
    if (slug.endsWith(`-${entryTitle}`)) score += 24;
    if (!isGenericOfficialDocsTitle(entryTitle) && searchablePage.includes(entryTitle)) score += 18;
  }
  if (entryUrlSlug !== undefined) {
    if (slug === entryUrlSlug) score += 34;
    if (slug.endsWith(`-${entryUrlSlug}`)) score += 24;
    if (searchablePage.includes(entryUrlSlug)) score += 12;
  }
  if (entryNamespace !== undefined && isGenericOfficialDocsTitle(entry.title)) {
    if (pageMatchesOfficialDocsNamespace({ namespace: entryNamespace, slug, title })) {
      score += 46;
    } else if (searchablePage.includes("react")) {
      score -= 32;
    }
  }
  for (const word of getOfficialDocsMatchWords(entryGroup)) {
    if (slug.includes(word) || title.includes(word) || purpose.includes(word)) score += 6;
  }

  return score;
}

function getOfficialDocsSectionOverviewTopic(input: {
  slug: string;
  title: string;
}): string | undefined {
  const candidates = [
    input.slug,
    input.title,
  ].flatMap((value) => {
    const normalized = normalizeSlugForComparison(value);
    const values: string[] = [];
    if (normalized.endsWith("-overview")) values.push(normalized.slice(0, -"overview".length - 1));
    if (normalized.startsWith("overview-")) values.push(normalized.slice("overview-".length));
    return values;
  });

  return candidates.find((candidate) =>
    candidate.length >= 2 &&
    !/^(docs?|documentation|project|repository|source|official|guide|guides|reference)$/.test(candidate)
  );
}

function officialDocsEntryMentionsTopic(
  entry: OfficialDocsIndex["entries"][number],
  topic: string,
): boolean {
  const normalizedTopic = normalizeSlugForComparison(topic);
  const entryText = normalizeSlugForComparison([
    entry.group ?? "",
    entry.title,
    entry.url,
  ].join(" "));
  if (entryText.includes(normalizedTopic)) return true;
  if (normalizedTopic.endsWith("s") && entryText.includes(normalizedTopic.slice(0, -1))) return true;
  return entryText.includes(`${normalizedTopic}s`);
}

function pageMatchesOfficialDocsNamespace(input: {
  namespace: string;
  slug: string;
  title: string;
}): boolean {
  const namespace = normalizeSlugForComparison(input.namespace);
  if (namespace.length === 0) return false;

  if (namespace === "react") {
    return /(^|-)react(-|$)/.test(input.slug) &&
      !/(^|-)react-dom(-|$)/.test(input.slug) &&
      !/(^|-)react-compiler(-|$)/.test(input.slug) &&
      !/(^|-)eslint-plugin-react-hooks(-|$)/.test(input.slug) &&
      !/(^|-)rules-of-react(-|$)/.test(input.slug);
  }

  return input.slug.includes(namespace) || input.title.includes(namespace);
}

function getOfficialDocsEntryUrlSlug(sourceUrl: string): string | undefined {
  try {
    const url = new URL(sourceUrl);
    const parts = url.pathname
      .replace(/\.(md|mdx|html?)$/i, "")
      .split("/")
      .map(normalizeSlugForComparison)
      .filter((part) => part.length > 0)
      .filter((part) => !/^(docs?|documentation|reference|learn|latest|current|stable)$/i.test(part));
    return parts.at(-1);
  } catch {
    return undefined;
  }
}

function getOfficialDocsMatchWords(value: string): string[] {
  const generic = new Set([
    "api",
    "apis",
    "docs",
    "documentation",
    "learn",
    "overview",
    "reference",
  ]);
  return value
    .split("-")
    .filter((word) => word.length >= 4 && !generic.has(word))
    .slice(0, 8);
}

function isGenericOfficialDocsTitle(value: string): boolean {
  const normalized = normalizeSlugForComparison(value).replace(/-/g, " ");
  return /^(adapters?|agents?|api|apis|architecture|auth|authentication|best practices|cli|commands?|components?|concepts?|config|configuration|database|databases|directives?|docs?|documentation|edge functions?|embeddings?|errors?|examples?|faq|foundations?|functions?|fundamentals?|getting started|guides?|hooks?|installation|integrations?|introduction|limits?|lints?|models?|options?|overview|pricing|providers?|quick start|quickstart|realtime|reference|resources?|routes?|routing|schemas?|search|security|setup|storage|tools?|troubleshooting|tutorials?|types?|vectors?)$/i.test(
    normalized,
  );
}

function expandOutlineWithOfficialDocs(input: {
  documentationSourceCount: number;
  fileCount: number;
  officialDocsIndex?: OfficialDocsIndex;
  outline: ParsedOutline;
  snapshot: PreparedRepositoryWorkspace;
  targetPageCount?: number;
}): ParsedOutline {
  const { officialDocsIndex, outline, snapshot } = input;
  if (officialDocsIndex === undefined || officialDocsIndex.entries.length === 0) {
    return outline;
  }

  const minPages = getMinOutlinePagesForEvidence({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsLinkCount: officialDocsIndex.linkCount,
  });
  const maxPages = getMaxOutlinePagesForEvidence({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsLinkCount: officialDocsIndex.linkCount,
  });
  const targetPageCount = Math.min(maxPages, Math.max(minPages, input.targetPageCount ?? minPages));
  if (outline.pages.length >= targetPageCount) return outline;

  const existingSlugs = new Set(outline.pages.map((page) => normalizeSlugForComparison(page.slug)));
  const existingTopicKeys = getOfficialDocsTopicKeysForPages({
    index: officialDocsIndex,
    pages: outline.pages,
  });
  const needed = targetPageCount - outline.pages.length;
  const selected = selectOfficialDocsOutlineEntries({
    count: needed,
    entries: officialDocsIndex.entries,
    existingSlugs,
    existingTopicKeys,
  });
  if (selected.length === 0) return outline;

  const addedPages: ParsedOutlinePage[] = selected.map((selection) => ({
    priority: "recommended",
    purpose: `Explain ${selection.entry.title} using the official docs structure and the repository source paths that implement or publish that surface.`,
    slug: selection.slug,
    sourcePaths: selectSourcePathsForOfficialDocsEntry({
      entry: selection.entry,
      snapshot,
    }),
    title: selection.entry.title,
  }));

  return {
    ...outline,
    navigation: mergeOfficialDocsNavigation({
      existingNavigation: outline.navigation,
      selected,
    }),
    pages: [...outline.pages, ...addedPages],
  };
}

function ensureAgentFrameworkPrimitivePages(input: {
  officialDocsIndex?: OfficialDocsIndex;
  outline: ParsedOutline;
  snapshot: PreparedRepositoryWorkspace;
}): ParsedOutline {
  const { officialDocsIndex, outline } = input;
  if (!isAgentFrameworkDocsIndex(officialDocsIndex)) return outline;

  const labelText = getOutlineLabelSearchText(outline);
  const missingFamilies = getAgentFrameworkPrimitiveFamilies(officialDocsIndex)
    .filter((family) => !family.outlinePattern.test(labelText));
  if (missingFamilies.length === 0) return outline;

  const usedSlugs = new Set(outline.pages.map((page) => normalizeSlugForComparison(page.slug)));
  const addedPages: ParsedOutlinePage[] = [];

  for (const family of missingFamilies) {
    const entry = findBestOfficialDocsEntryForAgentFamily(officialDocsIndex, family.evidencePattern);
    if (entry === undefined) continue;

    const slug = createOfficialDocsPageSlug(entry, usedSlugs);
    usedSlugs.add(slug);
    addedPages.push({
      priority: "required",
      purpose: `Explain ${family.label} as a first-class agent-framework primitive, using the first-party docs and source files that define the public behavior.`,
      slug,
      sourcePaths: selectSourcePathsForOfficialDocsEntry({
        entry,
        snapshot: input.snapshot,
      }),
      title: cleanNavigationTitle(family.label),
    });
  }

  if (addedPages.length === 0) return outline;

  return {
    ...outline,
    pages: [...outline.pages, ...addedPages],
  };
}

function findBestOfficialDocsEntryForAgentFamily(
  index: OfficialDocsIndex,
  pattern: RegExp,
): OfficialDocsIndex["entries"][number] | undefined {
  return index.entries
    .filter((entry) => pattern.test(`${entry.group ?? ""} ${entry.title} ${entry.url}`))
    .map((entry) => ({
      entry,
      score: scoreAgentFamilyEntry(entry),
    }))
    .sort((a, b) => b.score - a.score || a.entry.url.localeCompare(b.entry.url))[0]?.entry;
}

function scoreAgentFamilyEntry(entry: OfficialDocsIndex["entries"][number]): number {
  let score = 0;
  const title = normalizeSlugForComparison(entry.title);
  const urlSlug = getOfficialDocsEntryUrlSlug(entry.url);
  const url = normalizeSlugForComparison(entry.url);

  if (url.includes("docs")) score += 20;
  if (title === urlSlug) score += 16;
  if (!isGenericOfficialDocsTitle(entry.title)) score += 12;
  if (/^(overview|introduction|getting-started|quickstart)$/.test(title)) score -= 18;
  if (/\b(where|which|when|why|how)\b/.test(title.replace(/-/g, " "))) score -= 10;

  return score;
}

function selectOfficialDocsOutlineEntries(input: {
  count: number;
  entries: OfficialDocsIndex["entries"];
  existingSlugs: Set<string>;
  existingTopicKeys: Set<string>;
}): Array<{
  entry: OfficialDocsIndex["entries"][number];
  groupParts: string[];
  slug: string;
}> {
  const candidatesByTopicKey = new Map<string, {
    entry: OfficialDocsIndex["entries"][number];
    groupParts: string[];
    score: number;
  }>();

  for (const entry of input.entries) {
    const topicKey = getOfficialDocsTopicKeyForEntry(entry);
    if (input.existingTopicKeys.has(topicKey)) continue;

    const groupParts = getOfficialDocsNavigationGroupParts(entry);
    const score = scoreOfficialDocsOutlineEntry(entry, groupParts);
    const existing = candidatesByTopicKey.get(topicKey);
    if (existing === undefined || score > existing.score) {
      candidatesByTopicKey.set(topicKey, { entry, groupParts, score });
    }
  }

  const groups = new Map<string, Array<{
    entry: OfficialDocsIndex["entries"][number];
    groupParts: string[];
    score: number;
    slug: string;
  }>>();
  const usedSlugs = new Set(input.existingSlugs);

  for (const candidate of candidatesByTopicKey.values()) {
    const { entry, groupParts, score } = candidate;
    const slug = createOfficialDocsPageSlug(entry, usedSlugs);
    usedSlugs.add(slug);
    const key = groupParts.join(" / ");
    groups.set(key, [...(groups.get(key) ?? []), { entry, groupParts, score, slug }]);
  }

  for (const entries of groups.values()) {
    entries.sort(compareOfficialDocsOutlineCandidates);
  }

  const orderedGroups = [...groups.entries()]
    .sort((a, b) => scoreOfficialDocsOutlineGroup(b[0], b[1]) - scoreOfficialDocsOutlineGroup(a[0], a[1]));
  const selected: Array<{
    entry: OfficialDocsIndex["entries"][number];
    groupParts: string[];
    slug: string;
  }> = [];

  let cursor = 0;
  while (selected.length < input.count && orderedGroups.length > 0) {
    const [key, entries] = orderedGroups[cursor % orderedGroups.length] as [string, Array<{
      entry: OfficialDocsIndex["entries"][number];
      groupParts: string[];
      score: number;
      slug: string;
    }>];
    const next = entries.shift();
    if (next !== undefined) selected.push(next);
    if (entries.length === 0) {
      orderedGroups.splice(cursor % orderedGroups.length, 1);
      cursor = 0;
    } else {
      groups.set(key, entries);
      cursor += 1;
    }
  }

  return selected;
}

function compareOfficialDocsOutlineCandidates(
  a: {
    entry: OfficialDocsIndex["entries"][number];
    groupParts: string[];
    score: number;
    slug: string;
  },
  b: {
    entry: OfficialDocsIndex["entries"][number];
    groupParts: string[];
    score: number;
    slug: string;
  },
): number {
  return b.score - a.score ||
    a.groupParts.join(" / ").localeCompare(b.groupParts.join(" / ")) ||
    a.entry.title.localeCompare(b.entry.title) ||
    a.entry.url.localeCompare(b.entry.url);
}

function getOfficialDocsTopicKeysForPages(input: {
  index: OfficialDocsIndex;
  pages: ParsedOutlinePage[];
}): Set<string> {
  const keys = new Set<string>();
  for (const page of input.pages) {
    const entry = findOfficialDocsEntryForOutlinePage(page, input.index);
    if (entry !== undefined) {
      keys.add(getOfficialDocsTopicKeyForEntry(entry));
      continue;
    }

    const title = normalizeSlugForComparison(page.title);
    if (title.length > 0) keys.add(`title:${title}`);
  }
  return keys;
}

function getOfficialDocsTopicKeyForEntry(entry: OfficialDocsIndex["entries"][number]): string {
  const title = normalizeSlugForComparison(entry.title);
  const namespace = getOfficialDocsUrlNamespace(entry.url);
  if (namespace !== undefined && isGenericOfficialDocsTitle(entry.title)) {
    return `namespaced:${namespace}:${title}`;
  }

  if (title.length > 0 && !isGenericOfficialDocsTitle(entry.title)) {
    return `title:${title}`;
  }

  const urlSlug = getOfficialDocsEntryUrlSlug(entry.url);
  if (urlSlug !== undefined) {
    return `url:${urlSlug}`;
  }

  return `url:${normalizeSlugForComparison(entry.url)}`;
}

function scoreOfficialDocsOutlineEntry(entry: OfficialDocsIndex["entries"][number], groupParts: string[]): number {
  const text = `${groupParts.join(" ")} ${entry.group ?? ""} ${entry.title} ${entry.url}`;
  let score = 0;

  if (/(overview|introduction|what is|why|fundamentals?)/i.test(text)) score += 115;
  if (/(getting started|quick start|quickstart|installation|setup|tutorial|first app|start here)/i.test(text)) score += 110;
  if (/(learn|concept|foundation|architecture|mental model|component|state|effect|render|routing|caching|data fetching|compiler)/i.test(text)) score += 90;
  if (/(guide|workflow|usage|how to|integration|deploy|testing|migration|upgrade|production|debug)/i.test(text)) score += 82;
  if (/(example|cookbook|recipe|troubleshoot|troubleshooting|error|faq)/i.test(text)) score += 72;
  if (/(api|reference|hooks?|components?|configuration|config|command|cli|file system|function|method|option|schema|type)/i.test(text)) score += 58;
  if (/(ai|agent|models?|providers?|embeddings?|vectors?|search|database|storage|auth|authentication|realtime|edge functions?)/i.test(text)) score += 66;

  if (/\/(learn|docs|guide|guides|tutorial|tutorials|concepts?|fundamentals?|getting-started|quickstart)(\/|$)/i.test(entry.url)) {
    score += 34;
  }
  if (/\/(examples?|cookbook|recipes?|troubleshooting|migration|upgrade)(\/|$)/i.test(entry.url)) {
    score += 22;
  }
  if (/\/(api|reference)(\/|$)/i.test(entry.url)) {
    score += 10;
  }
  if (isGeneratedOfficialDocsEntry(entry)) {
    score -= 115;
  }
  if (isLowLevelOfficialDocsSymbolEntry(entry)) {
    score -= 38;
  }
  if (isNarrowPackageMemberOfficialDocsEntry(entry)) {
    score -= 28;
  }

  return score;
}

function scoreOfficialDocsOutlineGroup(
  group: string,
  entries: Array<{ entry: OfficialDocsIndex["entries"][number]; score: number }>,
): number {
  const highValueEntryCount = entries.filter((entry) => entry.score >= 50).length;
  let score = Math.min(Math.max(highValueEntryCount, Math.ceil(entries.length / 6)), 80);
  if (/(getting started|quick start|quickstart|installation|setup|tutorial|learn)/i.test(group)) score += 90;
  if (/(concept|architecture|state|effect|component|routing|render|caching)/i.test(group)) score += 70;
  if (/(guide|workflow|usage|how to|integration|deploy|testing|migration)/i.test(group)) score += 65;
  if (/(api|reference|hooks?|components?|configuration|command|cli|file system|function)/i.test(group)) score += 55;
  if (/(ai|agent|models?|providers?|embeddings?|vectors?|search|database|storage|auth|authentication|realtime|edge functions?)/i.test(group)) score += 58;
  if (/(example|cookbook|troubleshoot|error|faq)/i.test(group)) score += 45;
  if (entries.length >= 6 && entries.every((candidate) => isGeneratedOfficialDocsEntry(candidate.entry))) {
    score -= 55;
  }
  return score;
}

function isGeneratedOfficialDocsEntry(entry: OfficialDocsIndex["entries"][number]): boolean {
  const text = `${entry.group ?? ""} ${entry.title} ${entry.url}`;
  return /\/(?:generated|autoapi|autodoc|api-docs)\//i.test(entry.url) ||
    /\b(auto[-\s]?generated|generated reference|generated api|api docs)\b/i.test(text);
}

function isLowLevelOfficialDocsSymbolEntry(entry: OfficialDocsIndex["entries"][number]): boolean {
  const title = entry.title.trim();
  return /^(?:[A-Za-z_$][\w$]*\.){2,}[A-Za-z_$][\w$]*(?:\(\))?$/.test(title) ||
    /^(?:torch|tensorflow|tf|numpy|jax|sklearn|pandas|keras|scipy|matplotlib)\.[\w.]+(?:\(\))?$/i.test(title);
}

function isNarrowPackageMemberOfficialDocsEntry(entry: OfficialDocsIndex["entries"][number]): boolean {
  const title = normalizeSlugForComparison(entry.title);
  if (title.length === 0) return false;
  return title.split("-").length >= 5 &&
    !/(getting-started|quickstart|overview|guide|tutorial|concept|configuration|examples|troubleshooting|migration)/i.test(title);
}

function createOfficialDocsPageSlug(
  entry: OfficialDocsIndex["entries"][number],
  usedSlugs: Set<string>,
): string {
  const namespace = getOfficialDocsUrlNamespace(entry.url);
  const groupParts = entry.group
    ?.split(/\s+\/\s+/)
    .map(normalizeSlugForComparison)
    .filter((part) => part.length > 0)
    .slice(-2) ?? [];
  const namespacedGroupParts = applyOfficialDocsUrlNamespace({
    groupParts,
    namespace,
    title: entry.title,
  });
  const baseTitle = normalizeSlugForComparison(entry.title);
  let slugGroupParts = namespacedGroupParts;
  if (baseTitle.length > 0 && namespacedGroupParts.at(-1) === baseTitle) {
    slugGroupParts = namespacedGroupParts.slice(0, -1);
  } else if (baseTitle.length > 0 && !isGenericOfficialDocsTitle(entry.title) && namespacedGroupParts.includes(baseTitle)) {
    slugGroupParts = [];
  }
  const group = slugGroupParts.join("-");
  const base = normalizeSlugForComparison([group, baseTitle].filter(Boolean).join("-")) || "official-docs-page";
  let slug = base;
  let suffix = 2;
  while (usedSlugs.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function getOfficialDocsNavigationGroupParts(entry: OfficialDocsIndex["entries"][number]): string[] {
  const namespace = getOfficialDocsUrlNamespace(entry.url);
  const rawGroupParts = entry.group
    ?.split(/\s+\/\s+/)
    .map(normalizeSlugForComparison)
    .filter((part) => part.length > 0 && !/^(docs?|documentation)$/i.test(part))
    .slice(0, 3) ?? [];
  const groupParts = applyOfficialDocsUrlNamespace({
    groupParts: rawGroupParts,
    namespace,
    title: entry.title,
  })
    .map((part) => cleanNavigationTitle(part.replace(/[-_]+/g, " ")))
    .filter(isUsefulOfficialDocsTopic);

  if (groupParts.length > 0) return groupParts;
  try {
    const url = new URL(entry.url);
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .filter((part) => !/^(docs?|documentation|app|pages|en|latest|current|stable)$/i.test(part))
      .filter((part) => !/^(?:v?\d+(?:\.\d+)*)$/i.test(part))
      .slice(0, 2)
      .map((part) => cleanNavigationTitle(part.replace(/[-_]+/g, " ")))
      .filter(isUsefulOfficialDocsTopic);
    return parts.length > 0 ? parts : ["Official Docs"];
  } catch {
    return ["Official Docs"];
  }
}

function applyOfficialDocsUrlNamespace(input: {
  groupParts: string[];
  namespace: string | undefined;
  title: string;
}): string[] {
  const { namespace } = input;
  if (namespace === undefined || !isGenericOfficialDocsTitle(input.title)) {
    return input.groupParts;
  }

  const groupParts = [...input.groupParts];
  if (groupParts[0] === "react" && namespace.startsWith("react-")) {
    groupParts[0] = namespace;
    return groupParts;
  }
  if (!groupParts.includes(namespace)) {
    return [namespace, ...groupParts];
  }
  return groupParts;
}

function getOfficialDocsUrlNamespace(sourceUrl: string): string | undefined {
  try {
    const pathname = new URL(sourceUrl).pathname.toLowerCase();
    if (/\/reference\/eslint-plugin-react-hooks(?:\.md|\/|$)/.test(pathname)) return "eslint-plugin-react-hooks";
    if (/\/reference\/rules(?:\.md|\/|$)/.test(pathname)) return "rules-of-react";
    if (/\/reference\/react-dom\/server(?:\.md|\/|$)/.test(pathname)) return "react-dom-server";
    if (/\/reference\/react-dom\/static(?:\.md|\/|$)/.test(pathname)) return "react-dom-static";
    if (/\/reference\/react-dom\/client(?:\.md|\/|$)/.test(pathname)) return "react-dom-client";
    if (/\/reference\/react-dom(?:\.md|\/|$)/.test(pathname)) return "react-dom";
    if (/\/reference\/react(?:\.md|\/|$)/.test(pathname)) return "react";
    if (/\/learn\/react-compiler(?:\/|$)/.test(pathname)) return "react-compiler";
    const docsNamespace = pathname.match(/\/docs\/(?:guides\/)?(ai|api|auth|authentication|cli|cron|database|databases|deployment|edge-functions|embeddings|functions|integrations|local-development|models|platform|providers|queues|realtime|resources|search|security|storage|vector|vectors)(?:\/|$)/)?.[1];
    if (docsNamespace !== undefined) return docsNamespace;
    return undefined;
  } catch {
    return undefined;
  }
}

function mergeOfficialDocsNavigation(input: {
  existingNavigation: ParsedOutline["navigation"];
  selected: ReturnType<typeof selectOfficialDocsOutlineEntries>;
}): ParsedOutline["navigation"] {
  const officialRoots = new Map<string, ParsedOutline["navigation"][number]>();

  for (const selection of input.selected) {
    const [rootTitle = "Official Docs", secondTitle, thirdTitle] = selection.groupParts;
    const root = getOrCreateNavigationFolder(officialRoots, rootTitle);
    if (secondTitle === undefined) {
      root.children = [...(root.children ?? []), {
        slug: selection.slug,
        title: selection.entry.title,
      }];
      continue;
    }

    const second = getOrCreateChildFolder(root, secondTitle);
    if (thirdTitle === undefined) {
      second.children = [...(second.children ?? []), {
        slug: selection.slug,
        title: selection.entry.title,
      }];
      continue;
    }

    const third = getOrCreateChildFolder(second, thirdTitle);
    third.children = [...(third.children ?? []), {
      slug: selection.slug,
      title: selection.entry.title,
    }];
  }

  return [
    ...input.existingNavigation,
    ...[...officialRoots.values()].filter((node) => (node.children?.length ?? 0) > 0),
  ];
}

function getOrCreateNavigationFolder(
  folders: Map<string, ParsedOutline["navigation"][number]>,
  title: string,
): ParsedOutline["navigation"][number] {
  const existing = folders.get(title);
  if (existing !== undefined) return existing;
  const folder = { children: [], title };
  folders.set(title, folder);
  return folder;
}

function getOrCreateChildFolder(
  parent: ParsedOutline["navigation"][number],
  title: string,
): ParsedOutline["navigation"][number] {
  const children = parent.children ?? [];
  const existing = children.find((child) => child.title === title && child.slug === undefined);
  if (existing !== undefined) return existing;
  const folder = { children: [], title };
  parent.children = [...children, folder];
  return folder;
}

function cleanNavigationTitle(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => {
      if (/^(api|cli|css|dom|html|jsx|mcp|mdx|openapi|pwa|rsc|sdk|ui|url)$/i.test(word)) {
        return word.toUpperCase();
      }
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

export function selectSourcePathsForOfficialDocsEntry(input: {
  entry: OfficialDocsIndex["entries"][number];
  snapshot: PreparedRepositoryWorkspace;
}): string[] {
  const files = input.snapshot.fileInventory;
  const terms = getOfficialDocsSourceTerms({
    entry: input.entry,
    repoName: input.snapshot.repo,
  });

  const scoredCandidates = files
    .map((file) => ({
      file,
      score: scoreSourcePathForOfficialDocsEntry(file.path, terms, input.entry),
    }))
    .filter((item) => item.score >= 10)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const officialApiSpecCandidates = getOfficialApiSpecSourceCandidates({
    candidates: scoredCandidates,
    entry: input.entry,
  });
  const firstPartyDocsCandidates = getStrongFirstPartyDocsSourceCandidates({
    candidates: officialApiSpecCandidates.length > 0 ? [] : scoredCandidates,
    entry: input.entry,
  });
  const prioritizedCandidates = officialApiSpecCandidates.length > 0
    ? officialApiSpecCandidates
    : firstPartyDocsCandidates.length > 0
      ? firstPartyDocsCandidates
      : scoredCandidates;
  const filteredCandidates = filterOfficialDocsSourceCandidates({
    candidates: prioritizedCandidates,
    entry: input.entry,
  });
  const candidatePool = filteredCandidates.length > 0
    ? filteredCandidates
    : prioritizedCandidates;
  const sanitizedCandidates = sanitizeSelectedOfficialDocsSourceCandidates({
    candidates: candidatePool,
    entry: input.entry,
  });
  const sourceCandidates = sanitizedCandidates.length > 0
    ? sanitizedCandidates
    : shouldRequireSanitizedOfficialDocsSourceCandidates(input.entry)
      ? []
      : candidatePool;
  const scored = sanitizeSelectedOfficialDocsSourcePaths({
    entry: input.entry,
    paths: sourceCandidates
    .slice(0, 6)
      .map((item) => item.file.path),
  });

  if (scored.length > 0) return scored;

  const fallback = files
    .map((file) => ({
      file,
      score: scoreFallbackOfficialDocsSourcePath(file.path, input.snapshot.repo),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, 6)
    .map((item) => item.file.path);
  const sanitizedFallback = sanitizeSelectedOfficialDocsSourcePaths({
    entry: input.entry,
    paths: fallback,
  });
  return sanitizedFallback.length > 0 ? sanitizedFallback : fallback;
}

function getOfficialApiSpecSourceCandidates(input: {
  candidates: Array<{
    file: PreparedRepositoryWorkspace["fileInventory"][number];
    score: number;
  }>;
  entry: OfficialDocsIndex["entries"][number];
}): Array<{
  file: PreparedRepositoryWorkspace["fileInventory"][number];
  score: number;
}> {
  const specPath = getOfficialDocsApiSpecSourcePath(input.entry.url);
  const version = getOfficialDocsApiSpecVersion(input.entry.url);
  if (specPath === undefined || version === undefined) return [];
  const transformPath = `apps/docs/spec/transforms/api_${version}_openapi_deparsed.json`;

  const specCandidates = input.candidates.filter((item) =>
    item.file.path === specPath ||
    item.file.path === transformPath
  );
  return specCandidates.length > 0 ? specCandidates.slice(0, 2) : [];
}

function getStrongFirstPartyDocsSourceCandidates(input: {
  candidates: Array<{
    file: PreparedRepositoryWorkspace["fileInventory"][number];
    score: number;
  }>;
  entry: OfficialDocsIndex["entries"][number];
}): Array<{
  file: PreparedRepositoryWorkspace["fileInventory"][number];
  score: number;
}> {
  return input.candidates
    .map((item) => ({
      ...item,
      firstPartyDocsScore: scoreFirstPartyDocsSourceSpecificity(item.file.path, input.entry),
    }))
    .filter((item) => item.firstPartyDocsScore >= 140)
    .sort((a, b) =>
      b.firstPartyDocsScore - a.firstPartyDocsScore ||
      b.score - a.score ||
      a.file.path.localeCompare(b.file.path)
    )
    .slice(0, 3)
    .map(({ firstPartyDocsScore: _firstPartyDocsScore, ...item }) => item);
}

function sanitizeSelectedOfficialDocsSourcePaths(input: {
  entry: OfficialDocsIndex["entries"][number];
  paths: string[];
}): string[] {
  const sourceText = `${input.entry.group ?? ""} ${input.entry.title} ${input.entry.url}`;
  const normalizedSourceText = normalizeSlugForComparison(sourceText);
  const targetsLintDocs = /(?:^|-)(?:eslint|lint|lints|rules-of-hooks|exhaustive-deps|component-hook-factories)(?:-|$)/i.test(normalizedSourceText);
  const targetsTestingDocs = /(?:^|-)(?:test|tests|testing|act)(?:-|$)/i.test(normalizedSourceText);
  const isLearnDocs = /(?:^|-)learn(?:-|$)/i.test(normalizedSourceText) || /\/learn\//i.test(input.entry.url);
  const namespace = getOfficialDocsUrlNamespace(input.entry.url);
  const title = normalizeSlugForComparison(input.entry.title);

  return input.paths.filter((path) => {
    if (!targetsLintDocs && /^packages\/eslint-plugin-react-hooks\//i.test(path)) return false;
    if (!targetsTestingDocs && /^packages\/dom-event-testing-library\//i.test(path)) return false;
    if (isLearnDocs) {
      return /^(package\.json|readme\.md|packages\/react\/(package\.json|src\/)|packages\/react-reconciler\/src\/|packages\/react-dom-bindings\/src\/events\/|packages\/react-dom\/(client|server|static|package)\.js)/i.test(path);
    }
    if (namespace === "react-dom" && !/^(api|apis|components?|hooks?|overview)$/.test(title)) {
      return /^packages\/react-dom\/(index|npm\/index)\.js$/i.test(path) ||
        /^packages\/react-dom\/src\/shared\//i.test(path) ||
        /^packages\/react-dom-bindings\/src\/(client|shared)\//i.test(path);
    }
    return true;
  });
}

function shouldRequireSanitizedOfficialDocsSourceCandidates(entry: OfficialDocsIndex["entries"][number]): boolean {
  const sourceText = `${entry.group ?? ""} ${entry.title} ${entry.url}`;
  const normalizedSourceText = normalizeSlugForComparison(sourceText);
  const namespace = getOfficialDocsUrlNamespace(entry.url);
  const title = normalizeSlugForComparison(entry.title);
  return /(?:^|-)learn(?:-|$)/i.test(normalizedSourceText) ||
    /\/learn\//i.test(entry.url) ||
    (namespace === "react-dom" && !/^(api|apis|components?|hooks?|overview)$/.test(title));
}

function sanitizeSelectedOfficialDocsSourceCandidates(input: {
  candidates: Array<{
    file: PreparedRepositoryWorkspace["fileInventory"][number];
    score: number;
  }>;
  entry: OfficialDocsIndex["entries"][number];
}): Array<{
  file: PreparedRepositoryWorkspace["fileInventory"][number];
  score: number;
}> {
  const sourceText = `${input.entry.group ?? ""} ${input.entry.title} ${input.entry.url}`;
  const normalizedSourceText = normalizeSlugForComparison(sourceText);
  const isLearnDocs = /(?:^|-)learn(?:-|$)/i.test(normalizedSourceText) || /\/learn\//i.test(input.entry.url);
  const targetsLintDocs = /(?:^|-)(?:eslint|lint|lints|rules-of-hooks|exhaustive-deps|component-hook-factories)(?:-|$)/i.test(normalizedSourceText);
  const targetsTestingDocs = /(?:^|-)(?:test|tests|testing|act)(?:-|$)/i.test(normalizedSourceText);
  const namespace = getOfficialDocsUrlNamespace(input.entry.url);
  const title = normalizeSlugForComparison(input.entry.title);

  return input.candidates.filter((item) => {
    const path = item.file.path;
    if (!targetsLintDocs && /^packages\/eslint-plugin-react-hooks\//i.test(path)) return false;
    if (!targetsTestingDocs && /^packages\/dom-event-testing-library\//i.test(path)) return false;

    if (isLearnDocs) {
      return /^(package\.json|readme\.md|packages\/react\/(package\.json|src\/)|packages\/react-reconciler\/src\/|packages\/react-dom-bindings\/src\/events\/|packages\/react-dom\/(client|server|static|package)\.js)/i.test(path);
    }

    if (namespace === "react-dom" && !/^(api|apis|components?|hooks?|overview)$/.test(title)) {
      return /^packages\/react-dom\/(index|npm\/index)\.js$/i.test(path) ||
        /^packages\/react-dom\/src\/shared\//i.test(path) ||
        /^packages\/react-dom-bindings\/src\/(client|shared)\//i.test(path);
    }

    return true;
  });
}

function filterOfficialDocsSourceCandidates(input: {
  candidates: Array<{
    file: PreparedRepositoryWorkspace["fileInventory"][number];
    score: number;
  }>;
  entry: OfficialDocsIndex["entries"][number];
}): Array<{
  file: PreparedRepositoryWorkspace["fileInventory"][number];
  score: number;
}> {
  const namespace = getOfficialDocsUrlNamespace(input.entry.url);
  const title = normalizeSlugForComparison(input.entry.title);
  const group = normalizeSlugForComparison(input.entry.group ?? "");
  const sourceText = normalizeSlugForComparison(`${input.entry.group ?? ""} ${input.entry.title} ${input.entry.url}`);
  const targetsLintDocs = /(?:^|-)(?:eslint|lint|lints|rules-of-hooks|exhaustive-deps)(?:-|$)/i.test(sourceText);
  const targetsTestingDocs = /(?:^|-)(?:test|tests|testing|act)(?:-|$)/i.test(sourceText);
  const targetsCompilerDocs = /(?:^|-)(?:compiler|compilation)(?:-|$)/i.test(sourceText);
  const isReactLearnDocs = /(?:^|-)learn(?:-|$)|\/learn\//i.test(sourceText) || /\/learn\//i.test(input.entry.url);

  const withoutAdjacentTooling = input.candidates.filter((item) => {
    const path = item.file.path;
    if (!targetsLintDocs && /^packages\/eslint-plugin-react-hooks\//i.test(path)) return false;
    if (!targetsTestingDocs && /^packages\/dom-event-testing-library\//i.test(path)) return false;
    if (!targetsCompilerDocs && /(^|\/)(babel-plugin-react-compiler|react-compiler-runtime|eslint-plugin-react-hooks\/src\/rules\/ReactCompilerRule)/i.test(path)) {
      return false;
    }
    if (/(^|\/)(fixtures?|examples?|scripts)\/|^scripts\//i.test(path) && !targetsTestingDocs) return false;
    return true;
  });

  if (isReactLearnDocs || /^(installation|creating-a-react-app|adding-interactivity|describing-the-ui)$/.test(title)) {
    return withoutAdjacentTooling.filter((item) =>
      /^(package\.json|readme\.md|packages\/react\/(package\.json|src\/)|packages\/react-reconciler\/src\/|packages\/react-dom-bindings\/src\/events\/|packages\/react-dom\/(client|server|static|package)\.js)/i.test(item.file.path)
    );
  }

  if (namespace !== "react") {
    if (namespace === "react-dom" && !/^(api|apis|components?|hooks?|overview)$/.test(title)) {
      return withoutAdjacentTooling.filter((item) =>
        /^packages\/react-dom\/(index|npm\/index)\.js$/i.test(item.file.path) ||
        /^packages\/react-dom\/src\/shared\//i.test(item.file.path) ||
        /^packages\/react-dom-bindings\/src\/(client|shared)\//i.test(item.file.path)
      );
    }

    if (namespace === "react-dom-client") {
      return withoutAdjacentTooling.filter((item) =>
        /^packages\/react-dom\/(client|npm\/client)\.js$/i.test(item.file.path) ||
        /^packages\/react-dom\/src\/client\//i.test(item.file.path) ||
        /^packages\/react-dom-bindings\/src\/client\//i.test(item.file.path)
      );
    }

    if (namespace === "react-dom-server") {
      return withoutAdjacentTooling.filter((item) =>
        /^packages\/react-dom\/(server|npm\/server)\.js$/i.test(item.file.path) ||
        /^packages\/react-dom\/src\/server\//i.test(item.file.path) ||
        /^packages\/react-dom-bindings\/src\/server\//i.test(item.file.path) ||
        /^packages\/react-server\/src\//i.test(item.file.path)
      );
    }

    if (namespace === "react-dom-static") {
      return withoutAdjacentTooling.filter((item) =>
        /^packages\/react-dom\/(static|npm\/static)(?:\.|\/)/i.test(item.file.path) ||
        /^packages\/react-dom\/src\/server\//i.test(item.file.path) ||
        /^packages\/react-dom-bindings\/src\/server\//i.test(item.file.path)
      );
    }

    return withoutAdjacentTooling;
  }

  if (/^(api|apis|components?|overview)$/.test(title)) {
    return withoutAdjacentTooling.filter((item) =>
      /^packages\/react\/(package\.json|src\/)/i.test(item.file.path) &&
      !/(^|\/)(fixtures?|examples?|scripts)(\/|$)/i.test(item.file.path)
    );
  }

  if (title.startsWith("use") || title === "hooks" || group.includes("hooks")) {
    return withoutAdjacentTooling.filter((item) =>
      /^(packages\/react\/src\/|packages\/react-reconciler\/src\/|packages\/react-debug-tools\/src\/|packages\/react-server\/src\/)/i.test(item.file.path) &&
      !/(^|\/)(fixtures?|examples?|scripts)(\/|$)/i.test(item.file.path)
    );
  }

  return withoutAdjacentTooling;
}

function getOfficialDocsSourceTerms(input: {
  entry: OfficialDocsIndex["entries"][number];
  repoName: string;
}): Set<string> {
  const repoTerms = new Set(tokenizeOfficialDocsSourceText(input.repoName));
  const sourceText = `${input.entry.group ?? ""} ${input.entry.title} ${input.entry.url}`;
  const genericTerms = new Set([
    "about",
    "adding",
    "advanced",
    "api",
    "apis",
    "built",
    "compiler",
    "component",
    "components",
    "concept",
    "concepts",
    "data",
    "doc",
    "docs",
    "documentation",
    "example",
    "examples",
    "file",
    "files",
    "from",
    "getting",
    "guide",
    "guides",
    "html",
    "http",
    "https",
    "introduction",
    "learn",
    "overview",
    "page",
    "pages",
    "quick",
    "reference",
    "removing",
    "start",
    "started",
    "tutorial",
    "tutorials",
    "using",
    "your",
  ]);

  const terms = new Set(
    tokenizeOfficialDocsSourceText(sourceText)
      .filter((term) => !genericTerms.has(term))
      .filter((term) => !repoTerms.has(term))
      .filter((term, index, terms) => terms.indexOf(term) === index),
  );

  if (/\breact[-\s]+compiler\b/i.test(sourceText)) {
    terms.add("compiler");
  }
  if (/\/file-conventions\/page(?:[./?#]|$)/i.test(sourceText)) {
    terms.add("page");
  }
  if (/\/file-conventions\/layout(?:[./?#]|$)/i.test(sourceText)) {
    terms.add("layout");
  }
  if (/\/file-conventions\/route(?:[./?#]|$)/i.test(sourceText)) {
    terms.add("route");
  }
  const titleKey = normalizeSlugForComparison(input.entry.title);
  if (/^(api|apis|components?|configuration|directives|hooks?|lints?|overview)$/.test(titleKey)) {
    terms.add(titleKey);
  }

  return terms;
}

function scoreSourcePathForOfficialDocsEntry(
  path: string,
  terms: Set<string>,
  entry: OfficialDocsIndex["entries"][number],
): number {
  const firstPartyDocsScore = scoreFirstPartyDocsSourceSpecificity(path, entry);
  const normalized = path.toLowerCase();
  const pathTerms = tokenizeSourcePath(path);
  let score = firstPartyDocsScore;
  for (const term of terms) {
    const termScore = scoreOfficialDocsPathTerm(pathTerms, normalized, term);
    if (termScore > 0) score += termScore;
  }
  if (terms.has("dom") && normalized.includes("react-dom")) score += 12;
  score += scoreOfficialDocsApiSpecificity(path, normalized, pathTerms, terms);
  score += scoreOfficialDocsEntrySpecificity(path, normalized, entry, terms);
  if (score === 0) return 0;
  score += scoreOfficialDocsPathSpecificity(normalized, terms);
  score += scoreOfficialDocsToolingSpecificity(normalized, terms);
  if (isFirstPartyDocsContentPath(path)) score += 52;
  if (/^apps\/docs\/content\/(guides|reference|resources)\//i.test(path)) score += 18;
  if (/^apps\/docs\/content\/_partials\//i.test(path)) score -= 28;
  if (/^apps\/docs\/app\//i.test(path)) score += 10;
  if (/^\.agents\//i.test(path)) score -= 80;
  if (/^readme(\.mdx?)?$/i.test(path)) score += 12;
  if (/(^|\/)package\.json$/i.test(path)) score += 5;
  if (/(^|\/)(index|main|mod|lib)\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/i.test(path)) score += 10;
  if (/(^|\/)(api|client|server|config|options|schema|types|hooks?|components?)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) score += 12;
  if (/^\.github\//i.test(path)) {
    score += terms.has("ci") || terms.has("workflow") || terms.has("workflows") || terms.has("release") || terms.has("deploy") || terms.has("actions")
      ? 8
      : -64;
  }
  if (/^(scripts|tasks)\/(release|ci|deploy|publish|npm|yarn|github|workflow|workflows|rollup|build)\//i.test(path)) {
    score += targetsOperationalTooling(terms) ? 8 : -72;
  }
  if (/(^|\/)\.(claude|cursor)\//i.test(path)) score -= 80;
  if (/(^|\/)(bench|benchmark|benchmarks|evals)(\/|$)/i.test(path) || normalized.includes("turbopack-bench")) {
    score += terms.has("bench") || terms.has("benchmark") || terms.has("performance") || terms.has("eval") || terms.has("evals")
      ? 8
      : -56;
  }
  if (/(^|\/)(test|tests|__tests__|fixtures|__fixtures__|testdata)(\/|$)/i.test(path)) {
    score += targetsTestOrExampleDocs(terms) ? 14 : -16;
  }
  if (/(^|\/)(dist|build|coverage|vendor|vendored|compiled)(\/|$)/i.test(path)) score -= 20;
  if (/(^|\/)(playground|examples?|demo|demos)(\/|$)/i.test(path)) {
    score += targetsExampleDocs(terms) ? 18 : -30;
  }
  return score;
}

function scoreOfficialDocsPathTerm(pathTerms: string[], normalizedPath: string, term: string): number {
  if (pathTerms.includes(term)) {
    return term.length <= 3 ? 28 : term.length > 6 ? 18 : 14;
  }
  if (term.length <= 3) return 0;
  return normalizedPath.includes(term) ? (term.length > 6 ? 8 : 4) : 0;
}

function tokenizeSourcePath(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
}

function scoreFirstPartyDocsSourceSpecificity(
  path: string,
  entry: OfficialDocsIndex["entries"][number],
): number {
  const docsPathSegments = getComparableDocsPathSegments(path);
  if (docsPathSegments.length === 0) return 0;

  const docsUrlSegments = getComparableDocsUrlSegments(entry.url);
  if (docsUrlSegments.length === 0) return 0;

  let score = 0;
  if (endsWithSegments(docsPathSegments, docsUrlSegments)) {
    score += 160;
  } else if (endsWithSegments(docsPathSegments, docsUrlSegments.slice(1))) {
    score += 120;
  } else {
    const urlLeaf = docsUrlSegments.at(-1);
    const pathLeaf = docsPathSegments.at(-1);
    if (urlLeaf !== undefined && pathLeaf === urlLeaf) {
      score += 72;
    }
  }

  if (isFirstPartyDocsContentPath(path)) {
    score += 24;
  }

  return score;
}

function getComparableDocsUrlSegments(sourceUrl: string): string[] {
  try {
    const url = new URL(sourceUrl);
    const segments = url.pathname
      .split("/")
      .map(normalizeComparableDocsSegment)
      .filter((segment) => segment.length > 0)
      .filter((segment) => !/^(docs?|documentation|latest|current|stable)$/i.test(segment));
    return segments;
  } catch {
    return [];
  }
}

function getComparableDocsPathSegments(path: string): string[] {
  const rawSegments = path
    .replace(/\.(md|mdx|mdoc|txt|json|ya?ml|tsx?|jsx?)$/i, "")
    .split("/")
    .map(normalizeComparableDocsSegment)
    .filter((segment) => segment.length > 0);

  const knownPrefixes = [
    ["apps", "docs", "content"],
    ["apps", "docs", "src", "content"],
    ["apps", "web", "content"],
    ["apps", "www", "content"],
    ["content", "docs"],
    ["content"],
    ["docs", "source"],
    ["docs", "cpp", "source"],
    ["site", "docs"],
    ["site", "content"],
    ["website", "docs"],
    ["website", "content"],
    ["docs"],
  ];

  for (const prefix of knownPrefixes) {
    if (startsWithSegments(rawSegments, prefix)) {
      return rawSegments.slice(prefix.length);
    }
  }

  return [];
}

function isFirstPartyDocsContentPath(path: string): boolean {
  return /^(?:apps\/docs\/content|apps\/docs\/src\/content|apps\/web\/content|apps\/www\/content|content(?:\/docs)?|docs(?:\/source)?|site\/(?:docs|content)|website\/(?:docs|content))\//i.test(path);
}

function normalizeComparableDocsSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\d+-/, "")
    .replace(/\[\[?\.{3}(.+?)\]?\]/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function startsWithSegments(segments: string[], prefix: string[]): boolean {
  if (prefix.length > segments.length) return false;
  return prefix.every((segment, index) => segments[index] === segment);
}

function endsWithSegments(segments: string[], suffix: string[]): boolean {
  if (suffix.length === 0 || suffix.length > segments.length) return false;
  const offset = segments.length - suffix.length;
  return suffix.every((segment, index) => segments[offset + index] === segment);
}

function scoreOfficialDocsEntrySpecificity(
  path: string,
  normalizedPath: string,
  entry: OfficialDocsIndex["entries"][number],
  terms: Set<string>,
): number {
  const namespace = getOfficialDocsUrlNamespace(entry.url);
  const title = normalizeSlugForComparison(entry.title);
  let score = 0;
  const officialApiSpecPath = getOfficialDocsApiSpecSourcePath(entry.url);
  if (officialApiSpecPath !== undefined) {
    if (path === officialApiSpecPath) {
      score += 240;
    }
    if (/^apps\/docs\/spec\/transforms\/api_v\d+_openapi_deparsed\.json$/i.test(path)) {
      score += 96;
    }
    if (/^apps\/docs\/content\/guides\/api\//i.test(path)) {
      score -= 120;
    }
  }
  const targetsLintDocs = namespace === "eslint-plugin-react-hooks" ||
    terms.has("eslint") ||
    terms.has("lint") ||
    terms.has("lints") ||
    terms.has("rules") ||
    terms.has("exhaustive") ||
    terms.has("deps") ||
    terms.has("factories");

  if (normalizedPath.includes("eslint-plugin-react-hooks")) {
    score += targetsLintDocs ? 24 : -220;
  }
  if (normalizedPath.includes("dom-event-testing-library") && !terms.has("event") && !terms.has("events")) {
    score -= 180;
  }

  if (namespace === "react") {
    if (/(^|\/)(fixtures?|examples?|scripts)\/|^scripts\//i.test(path)) {
      score -= 140;
    }
    if (title === "components" && /^packages\/react\/src\/(ReactClient|ReactBaseClasses|ReactChildren|ReactElementType)\.js$/i.test(path)) {
      score += 96;
    }
    if (title === "components" && /^packages\/react\/src\/jsx\/ReactJSXElement\.js$/i.test(path)) {
      score += 104;
    }
    if (title === "hooks" && /^packages\/react\/src\/ReactHooks\.js$/i.test(path)) {
      score += 112;
    }
    if (title === "hooks" && /^packages\/react-reconciler\/src\/ReactFiberHooks\.js$/i.test(path)) {
      score += 104;
    }
    if (title === "hooks" && /^packages\/react-reconciler\/src\/ReactHookEffectTags\.js$/i.test(path)) {
      score += 64;
    }
    if ((title === "api" || title === "apis" || title === "overview") && /^packages\/react\/src\/ReactClient\.js$/i.test(path)) {
      score += 112;
    }
    if ((title === "api" || title === "apis" || title === "overview") && /^packages\/react\/package\.json$/i.test(path)) {
      score += 72;
    }
    if ((title === "api" || title === "apis" || title === "overview") && /^packages\/react\/src\/(ReactHooks|ReactAct|ReactBaseClasses|ReactChildren|ReactContext|ReactCreateRef|ReactForwardRef)\.js$/i.test(path)) {
      score += 72;
    }
  }

  if (namespace !== undefined && namespace.startsWith("react-dom")) {
    if (/^packages\/react-dom(\/|$)/i.test(path) || /^packages\/react-dom-bindings\//i.test(path)) {
      score += 42;
    }
    if (/^packages\/react\/src\//i.test(path) && title !== "hooks") {
      score -= 36;
    }
  }

  return score;
}

function getOfficialDocsApiSpecSourcePath(sourceUrl: string): string | undefined {
  const version = getOfficialDocsApiSpecVersion(sourceUrl);
  return version === undefined ? undefined : `apps/docs/spec/api_${version}_openapi.json`;
}

function getOfficialDocsApiSpecVersion(sourceUrl: string): string | undefined {
  try {
    const pathname = new URL(sourceUrl).pathname.toLowerCase();
    return pathname.match(/\/docs\/reference\/api\/(v\d+)(?:[-/]|$)/)?.[1];
  } catch {
    return undefined;
  }
}

function scoreOfficialDocsToolingSpecificity(normalizedPath: string, terms: Set<string>): number {
  let score = 0;
  const targetsLintTooling = terms.has("eslint") || terms.has("lint") || terms.has("lints");
  const mentionsLintTooling = /(^|\/|[-_.])(eslint|lint|lints)($|\/|[-_.])/.test(normalizedPath) ||
    (targetsLintTooling && /(^|\/|[-_.])rules?($|\/|[-_.])/.test(normalizedPath));

  if (mentionsLintTooling) {
    score += targetsLintTooling ? 32 : -56;
  }

  return score;
}

function scoreOfficialDocsApiSpecificity(
  path: string,
  normalizedPath: string,
  pathTerms: string[],
  terms: Set<string>,
): number {
  let score = 0;

  score += scoreGenericOfficialDocsSurfaceSpecificity(path, normalizedPath, pathTerms, terms);

  if (terms.has("act") && /(^|\/)ReactAct\.(js|jsx|ts|tsx)$/i.test(path)) {
    score += 72;
  }

  if (
    (terms.has("form") || terms.has("useformstatus")) &&
    (terms.has("status") || terms.has("state") || terms.has("useformstatus") || terms.has("useformstate")) &&
    /(^|\/)(ReactDOMFormActions|ReactFizzHooks|FormActionEventPlugin)\.(js|jsx|ts|tsx)$/i.test(path)
  ) {
    score += 64;
  }

  if (terms.has("dom") && terms.has("hooks")) {
    if (/^packages\/react-dom-bindings\/src\/shared\/ReactDOMFormActions\.js$/i.test(path)) {
      score += 72;
    }
    if (/^packages\/react-dom-bindings\/src\/events\/plugins\/FormActionEventPlugin\.js$/i.test(path)) {
      score += 56;
    }
    if (/^packages\/react-server\/src\/ReactFizzHooks\.js$/i.test(path)) {
      score += 48;
    }
    if (/^packages\/react-dom\/(server|npm\/server)\.js$/i.test(path) && !terms.has("server")) {
      score -= 64;
    }
  }

  if ((terms.has("exhaustive") || terms.has("deps") || terms.has("dependencies")) && /ExhaustiveDeps\.(js|jsx|ts|tsx)$/i.test(path)) {
    score += 72;
  }

  if (targetsReactEffects(terms)) {
    if (/^packages\/react\/src\/ReactHooks\.js$/i.test(path)) {
      score += 64;
    }
    if (/^packages\/react-reconciler\/src\/ReactFiberHooks\.js$/i.test(path)) {
      score += 88;
    }
    if (/^packages\/react-reconciler\/src\/ReactHookEffectTags\.js$/i.test(path)) {
      score += 80;
    }
    if (/^packages\/react-reconciler\/src\/ReactFiberCommitEffects\.js$/i.test(path)) {
      score += 76;
    }
    if (/^packages\/react-reconciler\/src\/ReactFiberWorkLoop\.js$/i.test(path)) {
      score += 36;
    }
    if (/^scripts\/release\/check-release-dependencies\.js$/i.test(path)) {
      score -= 120;
    }
  }

  if (terms.has("hooks") && terms.has("rules") && /RulesOfHooks\.(js|jsx|ts|tsx)$/i.test(path)) {
    score += 72;
  }
  if (terms.has("hooks") && terms.has("rules") && /ExhaustiveDeps\.(js|jsx|ts|tsx)$/i.test(path) && !terms.has("exhaustive") && !terms.has("deps")) {
    score -= 48;
  }

  if (
    (terms.has("hooks") && terms.has("rules")) &&
    /ValidateHooksUsage\.(js|jsx|ts|tsx|rs)$/i.test(path)
  ) {
    score += 48;
  }

  if (terms.has("usecallback") || (terms.has("callback") && terms.has("hooks"))) {
    if (/^packages\/react\/src\/ReactHooks\.js$/i.test(path)) {
      score += 96;
    }
    if (/^packages\/react-reconciler\/src\/ReactFiberHooks\.js$/i.test(path)) {
      score += 96;
    }
    if (/^packages\/react-reconciler\/src\/ReactPostPaintCallback\.js$/i.test(path)) {
      score -= 96;
    }
  }

  if (
    (terms.has("pure") || terms.has("purity") || terms.has("impure")) &&
    /(ValidateNoImpureFunctionsInRender|validate_no_.*impure|validate_hooks_usage)\.(js|jsx|ts|tsx|rs)$/i.test(path)
  ) {
    score += 56;
  }

  if (isReactLearnStateTarget(terms)) {
    if (/^packages\/react\/src\/ReactHooks\.js$/i.test(path)) {
      score += 76;
    }
    if (/^packages\/react-reconciler\/src\/ReactFiber(Hooks|ClassUpdateQueue|ConcurrentUpdates|Lane|WorkLoop)\.js$/i.test(path)) {
      score += 88;
    }
    if (/^packages\/react-reconciler\/src\/React(ChildFiber|FiberBeginWork)\.js$/i.test(path)) {
      score += terms.has("preserving") || terms.has("resetting") || terms.has("lists") ? 76 : 28;
    }
    if (/snapshot-resolver|SnapshotCommitList/i.test(path)) {
      score -= 96;
    }
  }

  if (terms.has("event") || terms.has("events") || terms.has("responding")) {
    if (/^packages\/react-dom-bindings\/src\/events\/(DOMPluginEventSystem|ReactDOMEventListener|SyntheticEvent|EventRegistry|DOMEventNames)\.js$/i.test(path)) {
      score += 92;
    }
    if (/^packages\/dom-event-testing-library\/domEvents\.js$/i.test(path)) {
      score += 20;
    }
  }

  if (terms.has("route") && (terms.has("handler") || terms.has("handlers"))) {
    if (/^packages\/next\/src\/server\/route-modules\/app-route\/module\.(ts|js)$/i.test(path)) {
      score += 108;
    }
    if (/^packages\/next\/src\/server\/route-modules\/app-route\/helpers\/[^/]+\.(ts|js)$/i.test(path)) {
      score += 84;
    }
    if (/^packages\/next\/src\/server\/route-(definitions|matcher|matcher-providers|matchers|matches)\/app-route/i.test(path)) {
      score += 56;
    }
    if (/^docs\/01-app\/01-getting-started\/15-route-handlers\.mdx$/i.test(path)) {
      score += 72;
    }
  }

  if (terms.has("mutating") || (terms.has("server") && (terms.has("action") || terms.has("actions")))) {
    if (/^docs\/01-app\/01-getting-started\/07-mutating-data\.mdx$/i.test(path)) {
      score += 78;
    }
    if (/^(crates\/next-(api|core|custom-transforms)\/src\/.*server_actions|packages\/next\/src\/server\/app-render\/action-handler)\.(rs|ts|tsx|js)$/i.test(path)) {
      score += 76;
    }
  }

  if (terms.has("cache") || terms.has("caching") || terms.has("cachetag") || terms.has("cachelife")) {
    if (/^docs\/01-app\/(01-getting-started\/08-caching|02-guides\/.*caching|03-api-reference\/0[14]-.*\/.*cache)/i.test(path)) {
      score += 58;
    }
    if (/^packages\/next\/src\/server\/(use-cache|lib\/incremental-cache|lib\/cache-handlers)\//i.test(path)) {
      score += 76;
    }
    if (/^packages\/next\/src\/server\/lib\/encode-cache-tag\.ts$/i.test(path)) {
      score += 52;
    }
  }

  if (terms.has("page")) {
    if (/^docs\/01-app\/03-api-reference\/03-file-conventions\/page\.mdx$/i.test(path)) {
      score += 96;
    }
    if (/^packages\/next\/src\/server\/route-modules\/app-page\/(module|module\.render)\.(ts|js)$/i.test(path)) {
      score += 132;
    }
    if (/^crates\/next-(core|custom-transforms)\/src\/.*page\.(rs|ts|js)$/i.test(path)) {
      score += 40;
    }
    if (/^docs\/02-pages\//i.test(path)) {
      score -= 48;
    }
  }

  if (terms.has("layout")) {
    if (/^docs\/01-app\/03-api-reference\/03-file-conventions\/layout\.mdx$/i.test(path)) {
      score += 96;
    }
    if (/^packages\/next\/src\/server\/route-modules\/app-page\/(module|module\.render)\.(ts|js)$/i.test(path)) {
      score += 52;
    }
  }

  if (terms.has("images") || terms.has("image")) {
    if (/^docs\/01-app\/03-api-reference\/05-config\/01-next-config-js\/images\.mdx$/i.test(path)) {
      score += 84;
    }
    if (/^packages\/next\/src\/(server\/image-optimizer|shared\/lib\/image-config|shared\/lib\/image-config-context\.shared-runtime)\.(ts|tsx|js)$/i.test(path)) {
      score += 74;
    }
  }

  if (terms.has("config") || terms.has("configuration")) {
    if (/^packages\/next\/src\/server\/config\.(ts|js)$/i.test(path)) {
      score += 58;
    }
    if (/^packages\/next\/src\/server\/typescript\/rules\/config\.(ts|js)$/i.test(path)) {
      score += 34;
    }
  }

  if (terms.has("compiler") && normalizedPath.includes("babel-plugin-react-compiler/src/")) {
    score += 28;
  }

  if (terms.has("compiler")) {
    if (/^compiler\/packages\/babel-plugin-react-compiler\/(README\.md|package\.json)$/i.test(path)) {
      score += 74;
    }
    if (/^compiler\/packages\/babel-plugin-react-compiler\/src\/(index|CompilerError)\.ts$/i.test(path)) {
      score += 74;
    }
    if (
      /^compiler\/packages\/babel-plugin-react-compiler\/src\/Entrypoint\/(index|Options|Pipeline|Program|Gating|Suppression|Imports|Reanimated)\.ts$/i.test(path)
    ) {
      score += 88;
    }
    if (
      /^compiler\/packages\/babel-plugin-react-compiler\/src\/Babel\/(BabelPlugin|RunReactCompilerBabelPlugin)\.ts$/i.test(path)
    ) {
      score += 84;
    }
    if (/^compiler\/packages\/react-compiler-runtime\/(README\.md|package\.json|src\/index\.ts)$/i.test(path)) {
      score += 56;
    }
    if (/^packages\/react\/(compiler-runtime|npm\/compiler-runtime)\.js$/i.test(path)) {
      score += 56;
    }
    if (terms.has("memo") && /^compiler\/packages\/babel-plugin-react-compiler\/src\/Validation\/ValidateUseMemo\.ts$/i.test(path)) {
      score += 128;
    }
    if (terms.has("memo") && /^compiler\/packages\/react-compiler-runtime\/src\/index\.ts$/i.test(path)) {
      score += 74;
    }
    if (
      terms.has("memo") &&
      /^compiler\/packages\/babel-plugin-react-compiler\/src\/Entrypoint\/(Gating|Imports|Pipeline|Reanimated)\.ts$/i.test(path)
    ) {
      score -= 42;
    }
    if (terms.has("gating") && /^compiler\/packages\/babel-plugin-react-compiler\/src\/Entrypoint\/Gating\.ts$/i.test(path)) {
      score += 48;
    }
    if (terms.has("logger") && /(^|\/)(Logger|logger)\.(ts|tsx|js|jsx)$/i.test(path)) {
      score += 48;
    }
    if (
      /^compiler\/packages\/babel-plugin-react-compiler\/src\/(Flood|HIR|Inference|Optimization|ReactiveScopes|SSA|Transform|TypeInference|Utils)\//i.test(path)
    ) {
      score += terms.has("architecture") || terms.has("pipeline") || terms.has("passes") ? -10 : -52;
    }
    if (/^compiler\/packages\/babel-plugin-react-compiler\/docs\/passes\//i.test(path)) {
      score += terms.has("architecture") || terms.has("pipeline") || terms.has("passes") ? 18 : -36;
    }
  }

  if (terms.has("legacy")) {
    if (
      /(^|\/)packages\/react\/src\/(ReactBaseClasses|ReactChildren|ReactCreateRef|ReactForwardRef|ReactClient)\.js$/i.test(path) ||
      /(^|\/)packages\/react\/src\/jsx\/ReactJSXElement\.js$/i.test(path)
    ) {
      score += 72;
    }
    if (
      normalizedPath.includes("react-devtools") ||
      normalizedPath.includes("reactflight") ||
      normalizedPath.includes("react-flight") ||
      normalizedPath.includes("dom-legacy") ||
      normalizedPath.includes("react-dom-bindings/src/server")
    ) {
      score -= 80;
    }
  }

  if (terms.has("render") && terms.has("commit")) {
    if (
      /(^|\/)packages\/react-reconciler\/src\/ReactFiber(BeginWork|CommitEffects|CommitWork|CompleteWork|Reconciler|WorkLoop)\.js$/i.test(path)
    ) {
      score += 84;
    }
    if (
      normalizedPath.includes("commit-convention") ||
      /(^|\/)\.(claude|cursor|github)\//.test(normalizedPath)
    ) {
      score -= 96;
    }
  }

  if (isRscSourceTarget(terms)) {
    if (
      normalizedPath.includes("react-server-dom") ||
      normalizedPath.includes("react-client/src/reactflight") ||
      normalizedPath.includes("react-dom-bindings/src/server/reactflight") ||
      normalizedPath.includes("react-dom-bindings/src/shared/reactflight")
    ) {
      score += 72;
    }
    if (terms.has("client") && /(^|\/|[-_.])client($|\/|[-_.])/.test(normalizedPath)) {
      score += 32;
    }
    if (terms.has("server") && /(^|\/|[-_.])server($|\/|[-_.])/.test(normalizedPath)) {
      score += 32;
    }
    if (normalizedPath.includes("react-devtools-shared")) {
      score -= 96;
    }
    if (/(^|\/)fixtures\//.test(normalizedPath)) {
      score -= 64;
    }
  }

  const targetsDevTools = terms.has("devtools") || (terms.has("developer") && terms.has("tools")) ||
    terms.has("profiler") || terms.has("performance");
  if (/react-devtools/i.test(path)) {
    score += targetsDevTools ? 24 : -88;
  }
  if (!terms.has("compiler") && /(react_compiler|babel-plugin-react-compiler)/i.test(path)) {
    score -= 72;
  }

  if (pathTerms.includes("test") || pathTerms.includes("tests")) {
    score += targetsTestOrExampleDocs(terms) ? 18 : -12;
  }

  return score;
}

function scoreGenericOfficialDocsSurfaceSpecificity(
  path: string,
  normalizedPath: string,
  pathTerms: string[],
  terms: Set<string>,
): number {
  let score = 0;

  const hasPathTerm = (...candidates: string[]) => candidates.some((candidate) => pathTerms.includes(candidate));
  const mentionsPathBoundary = (...candidates: string[]) =>
    candidates.some((candidate) => new RegExp(`(^|/|[-_.])${escapeRegExp(candidate)}($|/|[-_.])`).test(normalizedPath));

  if ((terms.has("route") || terms.has("routing") || terms.has("router")) && hasPathTerm("route", "routes", "router", "routing")) {
    score += 44;
  }
  if ((terms.has("cache") || terms.has("caching") || terms.has("revalidate") || terms.has("revalidation")) && hasPathTerm("cache", "caching", "revalidate", "revalidation")) {
    score += 44;
  }
  if ((terms.has("auth") || terms.has("authentication") || terms.has("authorization")) && hasPathTerm("auth", "authentication", "authorization", "oauth", "session", "sessions")) {
    score += 42;
  }
  if ((terms.has("form") || terms.has("forms")) && hasPathTerm("form", "forms", "action", "actions")) {
    score += 34;
  }
  if ((terms.has("image") || terms.has("images")) && hasPathTerm("image", "images", "img", "media")) {
    score += 38;
  }
  if ((terms.has("font") || terms.has("fonts")) && hasPathTerm("font", "fonts", "typography")) {
    score += 34;
  }
  if ((terms.has("metadata") || terms.has("opengraph") || terms.has("open") && terms.has("graph")) && hasPathTerm("metadata", "opengraph", "og", "head", "seo")) {
    score += 36;
  }
  if ((terms.has("proxy") || terms.has("middleware")) && hasPathTerm("proxy", "middleware", "interceptor", "interceptors")) {
    score += 42;
  }
  if ((terms.has("config") || terms.has("configuration") || terms.has("options")) && hasPathTerm("config", "configuration", "options", "settings")) {
    score += 44;
  }
  if ((terms.has("cli") || terms.has("command") || terms.has("commands")) && (hasPathTerm("cli", "command", "commands", "bin") || mentionsPathBoundary("bin"))) {
    score += 46;
  }
  if ((terms.has("adapter") || terms.has("adapters")) && hasPathTerm("adapter", "adapters", "runtime", "runtimes")) {
    score += 42;
  }
  if ((terms.has("directive") || terms.has("directives")) && hasPathTerm("directive", "directives", "server", "client")) {
    score += 36;
  }
  if ((terms.has("function") || terms.has("functions")) && hasPathTerm("function", "functions", "api", "server")) {
    score += 26;
  }
  if ((terms.has("component") || terms.has("components")) && hasPathTerm("component", "components", "ui")) {
    score += 30;
  }
  if ((terms.has("hook") || terms.has("hooks")) && hasPathTerm("hook", "hooks")) {
    score += 34;
  }
  if ((terms.has("schema") || terms.has("type") || terms.has("types")) && hasPathTerm("schema", "schemas", "type", "types", "typings")) {
    score += 34;
  }
  if ((terms.has("database") || terms.has("db") || terms.has("postgres") || terms.has("sql")) && hasPathTerm("database", "databases", "db", "postgres", "sql", "storage")) {
    score += 38;
  }
  if ((terms.has("storage") || terms.has("bucket") || terms.has("buckets")) && hasPathTerm("storage", "bucket", "buckets", "blob", "files")) {
    score += 36;
  }
  if ((terms.has("realtime") || terms.has("websocket") || terms.has("websockets")) && hasPathTerm("realtime", "websocket", "websockets", "channel", "channels", "subscription", "subscriptions")) {
    score += 38;
  }
  if ((terms.has("vector") || terms.has("embedding") || terms.has("embeddings") || terms.has("search")) && hasPathTerm("vector", "vectors", "embedding", "embeddings", "search", "retrieval", "index", "indexes")) {
    score += 40;
  }
  if ((terms.has("model") || terms.has("models") || terms.has("provider") || terms.has("providers")) && hasPathTerm("model", "models", "provider", "providers", "inference", "generate", "generation")) {
    score += 38;
  }
  if ((terms.has("agent") || terms.has("agents") || terms.has("tool") || terms.has("tools")) && hasPathTerm("agent", "agents", "tool", "tools", "workflow", "workflows")) {
    score += 38;
  }
  if (targetsExampleDocs(terms) && hasPathTerm("example", "examples", "demo", "demos", "template", "templates", "cookbook", "recipe", "recipes")) {
    score += 42;
  }
  if (targetsTestOrExampleDocs(terms) && hasPathTerm("test", "tests", "testing", "spec", "specs", "fixture", "fixtures")) {
    score += 42;
  }
  if ((terms.has("migration") || terms.has("migrate") || terms.has("upgrade") || terms.has("upgrading")) && hasPathTerm("migration", "migrations", "migrate", "upgrade", "upgrading", "codemod", "codemods")) {
    score += 40;
  }
  if ((terms.has("troubleshoot") || terms.has("troubleshooting") || terms.has("debug") || terms.has("debugging") || terms.has("error") || terms.has("errors")) && hasPathTerm("troubleshoot", "troubleshooting", "debug", "debugging", "error", "errors", "diagnostic", "diagnostics")) {
    score += 36;
  }

  if (score > 0 && /^docs?\//i.test(path)) {
    score += 18;
  }

  return score;
}

function scoreOfficialDocsPathSpecificity(normalizedPath: string, terms: Set<string>): number {
  let score = 0;
  const mentionsClient = /(^|\/|[-_.])client($|\/|[-_.])/.test(normalizedPath);
  const mentionsServer = /(^|\/|[-_.])server($|\/|[-_.])/.test(normalizedPath);
  const mentionsStatic = /(^|\/|[-_.])static($|\/|[-_.])/.test(normalizedPath);
  const targetsBothClientAndServer = terms.has("client") && terms.has("server");

  if (terms.has("client")) {
    if (mentionsClient) score += 22;
    if (!targetsBothClientAndServer && (mentionsServer || mentionsStatic)) score -= 44;
  }
  if (terms.has("server")) {
    if (mentionsServer) score += 22;
    if (!targetsBothClientAndServer && (mentionsClient || mentionsStatic)) score -= 44;
  }
  if (terms.has("static")) {
    if (mentionsStatic) score += 22;
    if (mentionsClient || mentionsServer) score -= 44;
  }

  return score;
}

function isRscSourceTarget(terms: Set<string>): boolean {
  if (terms.has("compiler")) return false;
  return terms.has("rsc") || terms.has("directives") || (
    terms.has("server") &&
    (terms.has("client") || terms.has("functions") || terms.has("components"))
  );
}

function isReactLearnStateTarget(terms: Set<string>): boolean {
  if (terms.has("dom") && terms.has("form")) return false;
  return terms.has("state") || terms.has("updates") || terms.has("queueing") ||
    terms.has("snapshot") || terms.has("memory") || terms.has("preserving") ||
    terms.has("resetting") || terms.has("reducer") || terms.has("context") ||
    terms.has("lists");
}

function targetsReactEffects(terms: Set<string>): boolean {
  if (terms.has("compiler")) return false;
  return terms.has("effect") || terms.has("effects") || terms.has("useeffect") ||
    terms.has("reactive") || terms.has("synchronizing");
}

function targetsOperationalTooling(terms: Set<string>): boolean {
  return terms.has("ci") || terms.has("workflow") || terms.has("workflows") ||
    terms.has("release") || terms.has("deploy") || terms.has("deployment") ||
    terms.has("publish") || terms.has("publishing") || terms.has("build") ||
    terms.has("bundling") || terms.has("rollup") || terms.has("npm") ||
    terms.has("yarn") || terms.has("actions");
}

function targetsExampleDocs(terms: Set<string>): boolean {
  return terms.has("example") || terms.has("examples") || terms.has("cookbook") ||
    terms.has("recipe") || terms.has("recipes") || terms.has("template") ||
    terms.has("templates") || terms.has("demo") || terms.has("demos");
}

function targetsTestOrExampleDocs(terms: Set<string>): boolean {
  return targetsExampleDocs(terms) ||
    terms.has("test") || terms.has("tests") || terms.has("testing") ||
    terms.has("spec") || terms.has("specs") || terms.has("cypress") ||
    terms.has("jest") || terms.has("playwright") || terms.has("vitest");
}

function scoreFallbackOfficialDocsSourcePath(path: string, repoName: string): number {
  const normalized = path.toLowerCase();
  let score = 0;
  if (/^readme(\.mdx?)?$/i.test(path)) score += 35;
  if (/^package\.json$/i.test(path)) score += 60;
  if (/^src\/(index|main|mod|lib)\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/i.test(path)) score += 55;
  if (new RegExp(`^packages/${escapeRegExp(repoName.toLowerCase())}/(index|package\\.json|src/(index|main|ReactClient)\\.(ts|tsx|js|jsx|mjs|cjs))$`, "i").test(path)) {
    score += 90;
  }
  if (/^packages\/[^/]+\/(index|package\.json|src\/(index|main|ReactClient)\.(ts|tsx|js|jsx|mjs|cjs))$/i.test(path)) {
    score += 45;
  }
  if (/(^|\/)(index|main|mod|lib)\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/i.test(path)) score += 20;
  if (/(^|\/)package\.json$/i.test(path)) score += 15;
  if (/(^|\/)(test|tests|__tests__|fixtures|__fixtures__|testdata|playground)(\/|$)/i.test(normalized)) score -= 60;
  if (/(^|\/)(dist|build|coverage|vendor|vendored|compiled)(\/|$)/i.test(normalized)) score -= 60;
  if (/(^|\/)(examples?|demo|demos)(\/|$)/i.test(normalized)) score -= 25;
  return Math.max(0, score);
}

function tokenizeOfficialDocsSourceText(text: string): string[] {
  const usefulShortTerms = new Set(["act", "api", "ci", "cli", "css", "dom", "jsx", "rsc", "sdk", "tsx"]);
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4 || usefulShortTerms.has(term));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOutlineSourcePaths(input: {
  outline: ParsedOutline;
  validPaths: Set<string>;
}): ParsedOutline {
  return {
    ...input.outline,
    concepts: input.outline.concepts.map((concept) => ({
      ...concept,
      sourcePaths: concept.sourcePaths.filter((path) => input.validPaths.has(path)),
    })),
    pages: input.outline.pages.map((page) => ({
      ...page,
      sourcePaths: page.sourcePaths.filter(
        (path) => input.validPaths.has(path) && !isInternalPlanningDocumentationPath(path),
      ),
    })),
  };
}

function pruneOutlineToGeneratedPages(outline: ParsedOutline, pages: ParsedPageDraft[]): ParsedOutline {
  const generatedSlugs = new Set(pages.map((page) => normalizeSlugForComparison(page.slug)));
  return normalizeOutlineNavigation({
    ...outline,
    navigation: pruneNavigation(outline.navigation, generatedSlugs),
    pages: outline.pages.filter((page) => generatedSlugs.has(normalizeSlugForComparison(page.slug))),
  });
}

function getOutlineQualityIssues(input: {
  documentationSourceCount: number;
  fileCount: number;
  officialDocsIndex?: OfficialDocsIndex;
  officialDocsLinkCount?: number;
  outline: ParsedOutline;
  repoName: string;
}): string[] {
  const issues: string[] = [];
  const minPages = getMinOutlinePagesForEvidence({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsLinkCount: input.officialDocsLinkCount,
  });
  if (input.outline.pages.length < minPages) {
    issues.push(
      `The outline has ${input.outline.pages.length} pages, but this repository needs at least ${minPages} source-backed pages.`,
    );
  }

  if (input.fileCount >= 500 && !hasReaderJourneyPages(input.outline.pages)) {
    issues.push(
      "Large developer repositories need a reader journey: include source-backed pages for getting started, core concepts, guides/workflows, reference/API, examples, or troubleshooting when supported.",
    );
  }

  if (input.documentationSourceCount >= 12 && !hasDocsSiteSpinePages(input.outline.pages)) {
    issues.push(
      "Docs-rich repositories need a docs-site spine based on first-party docs source: include source-backed pages across introduction/getting started, concepts/foundations, guides/workflows, API/reference/configuration, and examples/migration/troubleshooting when present.",
    );
  }

  issues.push(...getNavigationQualityIssues(input));
  issues.push(...getOfficialDocsCoverageIssues({
    officialDocsIndex: input.officialDocsIndex,
    outline: input.outline,
  }));
  issues.push(...getAgentFrameworkPrimitiveCoverageIssues({
    officialDocsIndex: input.officialDocsIndex,
    outline: input.outline,
  }));
  issues.push(...getOfficialDocsAlignmentIssues({
    officialDocsIndex: input.officialDocsIndex,
    outline: input.outline,
  }));

  const internalPlanningPages = input.outline.pages.filter(isInternalPlanningOutlinePage);
  if (internalPlanningPages.length > 0) {
    issues.push(
      `The outline includes internal planning/status pages that should not become public wiki pages: ${internalPlanningPages.slice(0, 8).map((page) => page.slug).join(", ")}. Replace them with reader-facing product, setup, architecture, generation flow, storage, chat, freshness, deployment, and operations pages grounded in source code and README evidence.`,
    );
  }

  const broadOfficialDocsIndex = (input.officialDocsIndex?.linkCount ?? 0) >= 80;
  if (input.fileCount >= 500 && !broadOfficialDocsIndex && hasImplementationCatalogDominance(input.outline.pages)) {
    issues.push(
      "The outline is too dominated by implementation catalog pages. Group similar adapters, providers, plugins, packages, integrations, or services, and add reader-facing guides, API/reference pages, examples, troubleshooting, or configuration pages when supported by source evidence.",
    );
  }

  const duplicateTopicPages = getRedundantOfficialDocsTopicPages(input.outline.pages);
  if (duplicateTopicPages.length > 0) {
    issues.push(
      `The outline duplicates public docs topics with both canonical and group-prefixed pages: ${duplicateTopicPages.slice(0, 10).map((page) => page.slug).join(", ")}. Keep one page per official-docs topic and replace duplicates with other focused official docs leaves.`,
    );
  }

  const duplicateSlugs = getDuplicateNormalizedSlugs(input.outline.pages);
  if (duplicateSlugs.length > 0) {
    issues.push(
      `Page slugs must be unique after normalization. Rename duplicate slug(s): ${duplicateSlugs.join(", ")}.`,
    );
  }

  const overviewPage = input.outline.pages.find(isOverviewPage);
  if (overviewPage === undefined) {
    issues.push(
      "Add a repository-level landing page with slug `overview`. Section overview pages must use specific slugs such as `channels-overview`, `tools-overview`, or `client-overview`.",
    );
  } else if (!isRepositoryOverviewPage(overviewPage, input.repoName)) {
    issues.push(
      `The page with slug \`overview\` is titled "${overviewPage.title}", but \`overview\` is reserved for the repository-level landing page. Rename subsystem overview slugs to specific names such as \`channels-overview\`, \`tools-overview\`, or \`client-overview\`.`,
    );
  }

  const folderWithSlug = findNavigationNodeWithSlugAndChildren(input.outline.navigation);
  if (folderWithSlug !== null) {
    issues.push(
      `Navigation node "${folderWithSlug}" has children and a slug. Folder nodes must omit slug; only leaf pages should have slug.`,
    );
  }

  const pagesWithoutSources = input.outline.pages.filter((page) => page.sourcePaths.length === 0);
  if (pagesWithoutSources.length > Math.max(1, Math.floor(input.outline.pages.length / 3))) {
    issues.push("Too many outline pages are missing sourcePaths. Add source paths for each page so workers get targeted evidence.");
  }

  return issues;
}

function getOfficialDocsCoverageIssues(input: {
  officialDocsIndex?: OfficialDocsIndex;
  outline: ParsedOutline;
}): string[] {
  const { officialDocsIndex, outline } = input;
  if (officialDocsIndex === undefined || officialDocsIndex.linkCount < 30) return [];

  const outlineText = getOutlineSearchText(outline);
  const evidenceFamilies = getOfficialDocsEvidenceFamilies(officialDocsIndex);
  const missingFamilies = evidenceFamilies
    .filter((family) => !family.outlinePattern.test(outlineText))
    .map((family) => family.label);

  const issues: string[] = [];
  if (missingFamilies.length > 0) {
    issues.push(
      `The official docs index has substantial ${missingFamilies.join(", ")} coverage. Add source-backed pages and navigation sections for those docs families instead of compressing them into broad overview pages.`,
    );
  }

  const missingHighVolumeTopics = isAgentFrameworkDocsIndex(officialDocsIndex)
    ? []
    : getMissingHighVolumeOfficialDocsTopics({
        index: officialDocsIndex,
        outlineText,
      });
  if (missingHighVolumeTopics.length >= 3) {
    issues.push(
      `Preserve more of the official docs section spine. Add focused pages or section folders for: ${missingHighVolumeTopics.slice(0, 8).join(", ")}.`,
    );
  }

  return issues;
}

function getAgentFrameworkPrimitiveCoverageIssues(input: {
  officialDocsIndex?: OfficialDocsIndex;
  outline: ParsedOutline;
}): string[] {
  const { officialDocsIndex, outline } = input;
  if (officialDocsIndex === undefined || officialDocsIndex.linkCount < 16) return [];

  const evidenceFamilies = getAgentFrameworkPrimitiveFamilies(officialDocsIndex);
  if (evidenceFamilies.length < 6) return [];

  const labelText = getOutlineLabelSearchText(outline);
  const missingFamilies = evidenceFamilies
    .filter((family) => !family.outlinePattern.test(labelText))
    .map((family) => family.label);

  const issues: string[] = [];
  if (missingFamilies.length > 0) {
    issues.push(
      `This repository has first-party docs for agent-framework primitives, but the outline is missing first-class pages or sidebar entries for: ${missingFamilies.slice(0, 12).join(", ")}. Add focused source-backed pages instead of combining these into broad overview pages.`,
    );
  }

  const minimumPrimitivePages = Math.min(24, Math.max(14, evidenceFamilies.length + 8));
  if (outline.pages.length < minimumPrimitivePages) {
    issues.push(
      `This docs-rich agent framework has ${evidenceFamilies.length} distinct documented primitive families. Expand the outline to at least ${minimumPrimitivePages} focused pages so major topics like tools, skills, channels, connections, sandbox, subagents, schedules, evals, sessions, configuration, and guides are not collapsed.`,
    );
  }

  return issues;
}

function getAgentFrameworkPrimitiveFamilies(index: OfficialDocsIndex): Array<{
  evidencePattern: RegExp;
  label: string;
  outlinePattern: RegExp;
}> {
  const entriesText = index.entries
    .map((entry) => `${entry.group ?? ""} ${entry.title} ${entry.url}`)
    .join("\n");
  const families = [
    {
      evidencePattern: /\binstructions?\b/i,
      label: "instructions",
      outlinePattern: /\binstructions?\b/i,
    },
    {
      evidencePattern: /\bagent[-\s]?config(?:uration)?\b|\bdefineagent\b|\bruntime config(?:uration)?\b/i,
      label: "agent configuration",
      outlinePattern: /\bagent[-\s]?config(?:uration)?\b|\bruntime config(?:uration)?\b|\bdefineagent\b/i,
    },
    {
      evidencePattern: /\btools?\b|\bdefineTool\b|\bhuman[-\s]?in[-\s]?the[-\s]?loop\b|\bapproval\b/i,
      label: "tools and approvals",
      outlinePattern: /\btools?\b|\bapproval\b|\bhuman[-\s]?in[-\s]?the[-\s]?loop\b/i,
    },
    {
      evidencePattern: /\bskills?\b/i,
      label: "skills",
      outlinePattern: /\bskills?\b/i,
    },
    {
      evidencePattern: /\bchannels?\b|\bslack\b|\bdiscord\b|\bteams\b|\btelegram\b|\btwilio\b|\bgithub\b|\blinear\b/i,
      label: "channels",
      outlinePattern: /\bchannels?\b|\bslack\b|\bdiscord\b|\bteams\b|\btelegram\b|\btwilio\b|\bgithub\b|\blinear\b/i,
    },
    {
      evidencePattern: /\bconnections?\b|\bmcp\b|\bopenapi\b|\bopen api\b|\boauth\b|\bvercel connect\b/i,
      label: "connections, MCP, and OpenAPI",
      outlinePattern: /\bconnections?\b|\bmcp\b|\bopenapi\b|\bopen api\b|\boauth\b|\bvercel connect\b/i,
    },
    {
      evidencePattern: /\bsandbox\b|\bsandboxes\b/i,
      label: "sandbox",
      outlinePattern: /\bsandbox\b|\bsandboxes\b/i,
    },
    {
      evidencePattern: /\bsubagents?\b|\bdelegat(?:e|ion)\b/i,
      label: "subagents",
      outlinePattern: /\bsubagents?\b|\bdelegat(?:e|ion)\b/i,
    },
    {
      evidencePattern: /\bschedules?\b|\bcron\b|\brecurring\b/i,
      label: "schedules",
      outlinePattern: /\bschedules?\b|\bcron\b|\brecurring\b/i,
    },
    {
      evidencePattern: /\bevals?\b|\bevaluations?\b|\bjudges?\b|\bassertions?\b|\breporters?\b/i,
      label: "evals",
      outlinePattern: /\bevals?\b|\bevaluations?\b|\bjudges?\b|\bassertions?\b|\breporters?\b/i,
    },
    {
      evidencePattern: /\bsessions?\b|\bstreaming\b|\bcontinuations?\b|\bmessages?\b|\bruns?\b/i,
      label: "sessions and streaming",
      outlinePattern: /\bsessions?\b|\bstreaming\b|\bcontinuations?\b|\bmessages?\b|\bruns?\b/i,
    },
    {
      evidencePattern: /\bfrontend\b|\bclient\b|\buseEveAgent\b|\bnextjs\b|\bnuxt\b|\bsveltekit\b|\bvue\b/i,
      label: "frontend and client integrations",
      outlinePattern: /\bfrontend\b|\bclient\b|\buseEveAgent\b|\bnextjs\b|\bnuxt\b|\bsveltekit\b|\bvue\b/i,
    },
    {
      evidencePattern: /\bhooks?\b|\binstrumentation\b|\blifecycle\b/i,
      label: "hooks and instrumentation",
      outlinePattern: /\bhooks?\b|\binstrumentation\b|\blifecycle\b/i,
    },
    {
      evidencePattern: /\bdeployment\b|\bdeploy\b|\bproduction\b|\broute protection\b|\bauth\b|\bauthentication\b/i,
      label: "deployment and auth",
      outlinePattern: /\bdeployment\b|\bdeploy\b|\bproduction\b|\broute protection\b|\bauth\b|\bauthentication\b/i,
    },
    {
      evidencePattern: /\bcli\b|\bcommands?\b|\bslash commands?\b|\bdev tui\b/i,
      label: "CLI and commands",
      outlinePattern: /\bcli\b|\bcommands?\b|\bslash commands?\b|\bdev tui\b/i,
    },
  ];

  return families.filter((family) => family.evidencePattern.test(entriesText));
}

function getOfficialDocsAlignmentIssues(input: {
  officialDocsIndex?: OfficialDocsIndex;
  outline: ParsedOutline;
}): string[] {
  const { officialDocsIndex, outline } = input;
  if (officialDocsIndex === undefined || officialDocsIndex.linkCount < 120 || outline.pages.length < 24) {
    return [];
  }

  const unmatchedPages = outline.pages.filter((page) =>
    !isOverviewPage(page) && findOfficialDocsEntryForOutlinePage(page, officialDocsIndex) === undefined
  );
  const suspiciousInternalPages = outline.pages.filter(isSuspiciousInternalOfficialDocsOutlinePage);
  const namespaceMismatchPages = getOfficialDocsNamespaceMismatchPages({
    officialDocsIndex,
    outline,
  });
  const issues: string[] = [];

  if (suspiciousInternalPages.length > 0) {
    issues.push(
      `The outline includes internal implementation-project pages that are not official-docs topics: ${suspiciousInternalPages.slice(0, 8).map((page) => page.slug).join(", ")}. Replace them with public official-docs pages.`,
    );
  }

  if (namespaceMismatchPages.length > 0) {
    issues.push(
      `The outline uses generic slugs for namespaced official docs topics: ${namespaceMismatchPages.slice(0, 8).map((page) => page.slug).join(", ")}. Include the URL namespace such as react-dom, react-dom-server, or eslint-plugin-react-hooks in generic reference page slugs and navigation titles.`,
    );
  }

  const allowedUnmatchedPages = Math.max(24, Math.floor(outline.pages.length * 0.6));
  if (
    suspiciousInternalPages.length > 0 &&
    unmatchedPages.length > allowedUnmatchedPages
  ) {
    issues.push(
      `Too many pages (${unmatchedPages.length}) do not match the broad official docs index. Keep the sidebar aligned with public official-docs topics and reserve source-only architecture or contributor material for the few places where it is useful.`,
    );
  }

  return issues;
}

function getOfficialDocsNamespaceMismatchPages(input: {
  officialDocsIndex: OfficialDocsIndex;
  outline: ParsedOutline;
}): ParsedOutlinePage[] {
  return input.outline.pages.filter((page) => {
    if (!isGenericOfficialDocsTitle(page.title)) return false;
    const entry = findOfficialDocsEntryForOutlinePage(page, input.officialDocsIndex);
    if (entry === undefined) return false;
    const namespace = getOfficialDocsUrlNamespace(entry.url);
    if (namespace === undefined || namespace === "react") return false;
    const slug = normalizeSlugForComparison(page.slug);
    return !slug.includes(namespace);
  });
}

function isSuspiciousInternalOfficialDocsOutlinePage(page: ParsedOutlinePage): boolean {
  const text = `${page.slug} ${page.title} ${page.purpose}`.toLowerCase();
  return /\b(rust[-\s]?port|porting notes?|gap analysis|orchestrator log|research notes?|implementation log|benchmark harness|scratchpad|todo)\b/.test(text) ||
    /\b(oxc|orchestrator)\b/.test(text);
}

function getOfficialDocsEvidenceFamilies(index: OfficialDocsIndex): Array<{
  label: string;
  outlinePattern: RegExp;
}> {
  const entries = index.entries;
  const families = [
    {
      evidencePattern: /(getting started|quick start|quickstart|installation|install|setup|tutorial|first app|start)/i,
      label: "getting-started/tutorial",
      minimum: 2,
      outlinePattern: /(getting started|quickstart|quick start|installation|install|setup|tutorial|first app|start)/i,
    },
    {
      evidencePattern: /(learn|concept|foundation|architecture|mental model|component|state|effect|render|routing|caching|data fetching|compiler)/i,
      label: "concepts/learning",
      minimum: 6,
      outlinePattern: /(learn|concept|foundation|architecture|mental model|component|state|effect|render|routing|caching|data|compiler)/i,
    },
    {
      evidencePattern: /(guide|workflow|how to|usage|pattern|auth|authentication|form|testing|deploy|production|debug|integration|migration|upgrade)/i,
      label: "guides/workflows",
      minimum: 5,
      outlinePattern: /(guide|workflow|how to|usage|pattern|auth|authentication|form|testing|deploy|production|debug|integration|migration|upgrade)/i,
    },
    {
      evidencePattern: /(api|reference|hook|hooks|component|function|directive|config|configuration|command|cli|file-system|option|prop|method|schema|type)/i,
      label: "API/reference",
      minimum: 5,
      outlinePattern: /(api|reference|hook|hooks|component|function|directive|config|configuration|command|cli|file-system|option|prop|method|schema|type)/i,
    },
    {
      evidencePattern: /(example|cookbook|recipe|troubleshoot|troubleshooting|debug|error|migration|upgrade|faq)/i,
      label: "examples/troubleshooting/migration",
      minimum: 3,
      outlinePattern: /(example|cookbook|recipe|troubleshoot|troubleshooting|debug|error|migration|upgrade|faq)/i,
    },
    {
      evidencePattern: /(agent|agents|ai|model|models|provider|providers|inference|embedding|embeddings|vector|vectors|search|database|storage|auth|authentication|realtime|edge function|edge functions)/i,
      label: "AI/data platform surfaces",
      minimum: 4,
      outlinePattern: /(agent|agents|ai|model|models|provider|providers|inference|embedding|embeddings|vector|vectors|search|database|storage|auth|authentication|realtime|edge function|edge functions)/i,
    },
    {
      evidencePattern: /(instructions?|tools?|skills?|channels?|connections?|mcp|openapi|open api|sandbox|subagents?|schedules?|evals?|sessions?|streaming|hooks?|agent config|configuration)/i,
      label: "agent framework primitives",
      minimum: 4,
      outlinePattern: /(instructions?|tools?|skills?|channels?|connections?|mcp|openapi|open api|sandbox|subagents?|schedules?|evals?|sessions?|streaming|hooks?|agent config|configuration)/i,
    },
  ];

  return families
    .filter((family) =>
      entries.filter((entry) =>
        family.evidencePattern.test(`${entry.group ?? ""} ${entry.title} ${entry.url}`),
      ).length >= family.minimum,
    )
    .map((family) => ({
      evidencePattern: family.evidencePattern,
      label: family.label,
      outlinePattern: family.outlinePattern,
    }));
}

function getMissingHighVolumeOfficialDocsTopics(input: {
  index: OfficialDocsIndex;
  outlineText: string;
}): string[] {
  const topics = getOfficialDocsTopicCounts(input.index)
    .filter((topic) => topic.count >= Math.max(4, Math.floor(input.index.linkCount / 80)))
    .slice(0, 12);

  return topics
    .filter((topic) => !outlineMentionsTopic(input.outlineText, topic.label))
    .map((topic) => topic.label);
}

function getOfficialDocsTopicCounts(index: OfficialDocsIndex): Array<{
  count: number;
  label: string;
}> {
  const counts = new Map<string, number>();

  for (const entry of index.entries) {
    const labels = new Set<string>();
    for (const label of entry.group?.split(/\s+\/\s+/) ?? []) {
      const normalized = normalizeOfficialDocsTopicLabel(label);
      if (isUsefulOfficialDocsTopic(normalized)) labels.add(normalized);
    }
    const urlLabel = getOfficialDocsTopicFromUrl(entry.url);
    if (urlLabel !== undefined && isUsefulOfficialDocsTopic(urlLabel)) labels.add(urlLabel);

    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ count, label }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function getOfficialDocsTopicFromUrl(sourceUrl: string): string | undefined {
  try {
    const url = new URL(sourceUrl);
    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .filter((segment) => !/^(docs?|documentation|app|pages|en|latest|current|stable)$/i.test(segment))
      .filter((segment) => !/^(?:v?\d+(?:\.\d+)*)$/i.test(segment));
    const candidate = segments.find((segment) =>
      /^(learn|getting-started|quickstart|guide|guides|api-reference|api|reference|hooks|components|functions|configuration|config|cli|architecture|examples|cookbook|migration|upgrade|troubleshooting|testing|deployment|deploying|routing|caching|rendering|data-fetching|file-system-conventions|directives|compiler|auth|authentication|database|databases|storage|realtime|edge-functions|vector|vectors|embeddings|embedding|ai|models|model|providers|provider|agents|agent|tools|tool|skills|skill|channels|channel|connections|connection|mcp|openapi|open-api|sandbox|subagents|subagent|schedules|schedule|evals|eval|sessions|session|streaming|instructions|instruction|inference|search)$/i.test(segment),
    );
    return candidate === undefined ? undefined : normalizeOfficialDocsTopicLabel(candidate);
  } catch {
    return undefined;
  }
}

function outlineMentionsTopic(outlineText: string, label: string): boolean {
  const words = getTopicWords(label);
  if (words.length === 0) return true;
  if (words.length === 1) return outlineText.includes(words[0] as string);
  return words.every((word) => outlineText.includes(word)) || outlineText.includes(compactTopicText(label));
}

function getTopicWords(label: string): string[] {
  const generic = new Set([
    "and",
    "api",
    "app",
    "docs",
    "documentation",
    "guide",
    "guides",
    "learn",
    "overview",
    "reference",
    "the",
  ]);
  return normalizeOfficialDocsTopicLabel(label)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !generic.has(word))
    .slice(0, 4);
}

function normalizeOfficialDocsTopicLabel(label: string): string {
  return label
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => {
      if (/^(api|cli|css|dom|html|jsx|mdx|pwa|rsc|sdk|ui|url)$/i.test(word)) {
        return word.toUpperCase();
      }
      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function isUsefulOfficialDocsTopic(label: string): boolean {
  if (label.length < 3 || label.length > 80) return false;
  if (label.includes("/")) return false;
  if (/^(blog|blog posts?|blog tags?|core pages?|pages?|tags?)$/i.test(label)) return false;
  if (/^(what to read next|where to go next|read next|next steps?|related(?: pages?| resources?| links?)?|on this page|in this article)$/i.test(label)) {
    return false;
  }
  return !/^(API|Apis|Docs|Documentation|Learn|Overview|Reference)$/i.test(label);
}

function getOutlineSearchText(outline: ParsedOutline): string {
  const navigationTitles: string[] = [];
  function visit(nodes: ParsedOutline["navigation"]): void {
    for (const node of nodes) {
      navigationTitles.push(node.title);
      visit(node.children ?? []);
    }
  }
  visit(outline.navigation);

  return compactSearchText([
    outline.title,
    outline.summary,
    ...navigationTitles,
    ...outline.pages.flatMap((page) => [page.title, page.slug, page.purpose]),
    ...outline.concepts.flatMap((concept) => [concept.name, concept.description]),
  ].join(" "));
}

function getOutlineLabelSearchText(outline: ParsedOutline): string {
  const navigationTitles: string[] = [];
  function visit(nodes: ParsedOutline["navigation"]): void {
    for (const node of nodes) {
      navigationTitles.push(node.title);
      visit(node.children ?? []);
    }
  }
  visit(outline.navigation);

  return compactSearchText([
    outline.title,
    ...navigationTitles,
    ...outline.pages.flatMap((page) => [page.title, page.slug]),
    ...outline.concepts.map((concept) => concept.name),
  ].join(" "));
}

function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function compactTopicText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasReaderJourneyPages(pages: ParsedOutline["pages"]): boolean {
  const labels = pages.map((page) => `${page.title} ${page.slug} ${page.purpose}`.toLowerCase());
  const requiredGroups = [
    /(overview|introduction|what|why)/,
    /(getting started|quickstart|setup|install|start)/,
    /(concept|architecture|foundation|model)/,
    /(guide|workflow|usage|tutorial|quickstart|quick start|pattern|integration|cookbook|example)/,
    /(api|reference|surface|command|configuration|option)/,
  ];

  return requiredGroups.filter((group) => labels.some((label) => group.test(label))).length >= 4;
}

function hasDocsSiteSpinePages(pages: ParsedOutline["pages"]): boolean {
  const labels = pages.map((page) => `${page.title} ${page.slug} ${page.purpose}`.toLowerCase());
  const minimumGroups = pages.length < 12 ? 4 : 5;
  const groups = [
    /(overview|introduction|what|why)/,
    /(getting started|quickstart|setup|install|start)/,
    /(concept|foundation|architecture|model|mental model)/,
    /(guide|workflow|usage|tutorial|quickstart|quick start|pattern|integration)/,
    /(api|reference|configuration|config|option|command|route|hook|provider)/,
    /(example|cookbook|recipe|migration|upgrade|troubleshoot|troubleshooting|error|faq)/,
  ];

  return groups.filter((group) => labels.some((label) => group.test(label))).length >= minimumGroups;
}

function getNavigationQualityIssues(input: {
  documentationSourceCount: number;
  fileCount: number;
  officialDocsIndex?: OfficialDocsIndex;
  officialDocsLinkCount?: number;
  outline: ParsedOutline;
}): string[] {
  const pageCount = input.outline.pages.length;
  if (pageCount < 6) return [];

  const stats = getNavigationStats(input.outline.navigation);
  const docsRich = input.documentationSourceCount >= 12 || (input.officialDocsLinkCount ?? 0) >= 30;
  const largeRepository = input.fileCount >= 500;
  if (!docsRich && !largeRepository) return [];

  const issues: string[] = [];
  if (stats.leafCount === 0) {
    issues.push(
      "Add a nested `navigation` sidebar with folder nodes and leaf pages. Do not rely on the fallback flat page list.",
    );
    return issues;
  }

  if (isSingleWrapperNavigation(input.outline.navigation, pageCount)) {
    issues.push(
      "The navigation is too shallow: every page is under one generic root folder. Split docs-rich repositories into multiple sibling folders such as Getting Started, Concepts, Guides, API Reference, Examples, Troubleshooting, and Operations.",
    );
  }

  const minimumRootFolders = docsRich &&
    (input.documentationSourceCount >= 40 || (input.officialDocsLinkCount ?? 0) >= 60) &&
    pageCount >= 10
    ? stats.maxDepth >= 2 ? 2 : 4
    : 2;
  if (stats.rootFolderCount < minimumRootFolders) {
    issues.push(
      `The navigation has ${stats.rootFolderCount} top-level folder(s), but this docs-rich repository needs at least ${minimumRootFolders} major sidebar sections.`,
    );
  }

  if (stats.rootLeafCount > Math.max(1, Math.floor(pageCount / 4))) {
    issues.push(
      "Too many pages sit at the sidebar root. Place leaf pages inside meaningful section folders.",
    );
  }

  const broadDocsTree = docsRich && pageCount >= 18 && (
    input.documentationSourceCount >= 80 ||
    (input.officialDocsLinkCount ?? 0) >= 80
  );
  if (broadDocsTree && stats.maxDepth < 2 && !isAgentFrameworkDocsIndex(input.officialDocsIndex)) {
    issues.push(
      "The navigation is still too flat for a broad docs tree. Add nested section folders so product areas, guide families, API families, examples, and operations are not all one level.",
    );
  }

  return issues;
}

function getNavigationStats(navigation: ParsedOutline["navigation"]): {
  folderCount: number;
  leafCount: number;
  maxDepth: number;
  rootFolderCount: number;
  rootLeafCount: number;
} {
  let folderCount = 0;
  let leafCount = 0;
  let maxDepth = 0;
  let rootFolderCount = 0;
  let rootLeafCount = 0;

  function visit(nodes: ParsedOutline["navigation"], depth: number): void {
    for (const node of nodes) {
      const childCount = node.children?.length ?? 0;
      if (childCount > 0) {
        folderCount += 1;
        if (depth === 1) rootFolderCount += 1;
        maxDepth = Math.max(maxDepth, depth);
        visit(node.children ?? [], depth + 1);
      } else if (node.slug !== undefined) {
        leafCount += 1;
        if (depth === 1) rootLeafCount += 1;
      }
    }
  }

  visit(navigation, 1);
  return {
    folderCount,
    leafCount,
    maxDepth,
    rootFolderCount,
    rootLeafCount,
  };
}

function isSingleWrapperNavigation(navigation: ParsedOutline["navigation"], pageCount: number): boolean {
  if (navigation.length !== 1) return false;
  const [root] = navigation;
  if (root === undefined || root.slug !== undefined || root.children === undefined) return false;
  if (root.children.length < Math.min(6, pageCount)) return false;
  return root.children.every((child) => child.slug !== undefined && (child.children?.length ?? 0) === 0);
}

function hasImplementationCatalogDominance(pages: ParsedOutline["pages"]): boolean {
  if (pages.length < 8) return false;

  const implementationCatalogPages = pages.filter((page) =>
    /(adapter|provider|plugin|integration|package|module|service|component|crate)s?\b/i.test(
      `${page.title} ${page.slug} ${page.purpose}`,
    ),
  ).length;
  const readerFacingPages = pages.filter((page) =>
    /(getting started|quickstart|setup|install|guide|tutorial|usage|workflow|example|cookbook|api|reference|configuration|option|troubleshoot|troubleshooting|error|faq|migration|upgrade)/i.test(
      `${page.title} ${page.slug} ${page.purpose}`,
    ),
  ).length;

  return implementationCatalogPages > Math.max(4, readerFacingPages + 2);
}

function getRedundantOfficialDocsTopicPages(pages: ParsedOutline["pages"]): ParsedOutlinePage[] {
  const pagesByTitle = new Map<string, ParsedOutlinePage[]>();
  for (const page of pages) {
    const titleKey = normalizeSlugForComparison(page.title);
    if (titleKey.length === 0) continue;
    pagesByTitle.set(titleKey, [...(pagesByTitle.get(titleKey) ?? []), page]);
  }

  return [...pagesByTitle.entries()].flatMap(([titleKey, titlePages]) => {
    if (titlePages.length < 2) return [];
    if (isAllowedGenericDuplicateTitle(titleKey)) return [];

    const hasCanonicalPage = titlePages.some((page) =>
      normalizeSlugForComparison(page.slug) === titleKey
    );
    if (!hasCanonicalPage) return [];

    return titlePages.filter((page) => {
      const slug = normalizeSlugForComparison(page.slug);
      return slug !== titleKey && slug.endsWith(`-${titleKey}`);
    });
  });
}

function getRedundantSetupLandingPages(pages: ParsedOutline["pages"]): ParsedOutlinePage[] {
  const outlineText = pages.map((page) => `${page.slug} ${page.title}`).join(" ").toLowerCase();
  const hasFocusedSetupLeaves = [
    /\bbuild[-\s].*from[-\s]scratch\b/,
    /\badd[-\s].*existing[-\s]project\b/,
    /\binstallation\b/,
    /\beditor[-\s]setup\b/,
    /\btypescript\b/,
  ].filter((pattern) => pattern.test(outlineText)).length >= 2;

  if (!hasFocusedSetupLeaves) return [];

  return pages.filter((page) => {
    const slug = normalizeSlugForComparison(page.slug);
    const text = `${slug} ${page.title} ${page.purpose}`.toLowerCase();
    return /^creating-a-[a-z0-9-]*app$/.test(slug) ||
      /^create-a-[a-z0-9-]*app$/.test(slug) ||
      /\bcreating[-\s]a[-\s][a-z0-9-]*[-\s]?app\b/.test(text);
  });
}

function isAllowedGenericDuplicateTitle(titleKey: string): boolean {
  return /^(api|apis|architecture|components?|concepts?|directives|errors?|examples?|faq|fundamentals?|guides?|hooks?|limits?|overview|pricing|reference|resources?|security|troubleshooting)$/.test(titleKey);
}

function getPageQualityIssues(input: {
  documentationSourceCount: number;
  draft: ParsedPageDraft;
  fileCount: number;
  officialDocsLinkCount?: number;
  page: ParsedOutlinePage;
  validSourcePaths: Set<string>;
}): string[] {
  const issues: string[] = [];
  const markdown = input.draft.markdown;
  const wordCount = countWords(markdown);
  const h2Count = countMarkdownHeadings(markdown, 2);
  const minWords = getMinPageWordsForTarget({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsLinkCount: input.officialDocsLinkCount,
    page: input.page,
  });
  const minSections = getMinPageSectionCount({
    documentationSourceCount: input.documentationSourceCount,
    fileCount: input.fileCount,
    officialDocsLinkCount: input.officialDocsLinkCount,
    page: input.page,
  });

  if (!markdown.trimStart().startsWith(`# ${input.draft.title}`) && !/^#\s+.+/m.test(markdown)) {
    issues.push("The page must start with a single # title.");
  }

  if (h2Count < minSections) {
    issues.push(`The page has ${h2Count} ## sections, but this page needs at least ${minSections} useful ## sections.`);
  }

  if (wordCount < minWords && !hasEnoughSubstantiveDetail({ markdown, minWords, wordCount })) {
    issues.push(`The page has about ${wordCount} words, but this page target needs at least ${minWords} words.`);
  }

  if (!/^##\s+Relevant Source Files\b/im.test(markdown)) {
    issues.push("Add a ## Relevant Source Files section that explains the important files for this page.");
  }

  const validCitationPaths = getValidCitationPaths(input.draft, input.validSourcePaths);
  const visibleSourcePaths = getVisibleSourcePaths({
    markdown,
    outlineSourcePaths: input.page.sourcePaths,
    validCitationPaths,
    validSourcePaths: input.validSourcePaths,
  });

  if (!/Sources:/i.test(markdown)) {
    issues.push("Include at least one visible Sources: line with concrete source paths.");
  } else if (visibleSourcePaths.length === 0) {
    issues.push("Visible page content must name at least one valid indexed repository source path near its Sources or Relevant Source Files material.");
  }

  if (input.draft.citations.length === 0) {
    issues.push("Include at least one structured citation for a concrete repository source path.");
  } else if (validCitationPaths.length === 0) {
    issues.push("At least one structured citation path must match an indexed repository source file.");
  } else if (!validCitationPaths.some((path) => markdown.includes(path))) {
    issues.push("Structured citation paths must also appear in visible Sources lines or page prose.");
  }

  if (
    input.page.sourcePaths.length > 0 &&
    validCitationPaths.length > 0 &&
    !input.page.sourcePaths.some((path) => validCitationPaths.includes(path))
  ) {
    issues.push("Cite at least one of the outline sourcePaths so the page stays grounded in its targeted evidence.");
  }

  const unrelatedSourcePaths = getUnrelatedVisibleSourcePaths({
    draft: input.draft,
    markdown,
    page: input.page,
  });
  for (const path of unrelatedSourcePaths) {
    issues.push(`Remove unrelated source path ${path} from page prose, Relevant Source Files, Sources lines, and citations.`);
  }

  if (isReferenceLikePage(input.page) && !hasReferenceDetail(markdown)) {
    issues.push(
      "Reference-like pages need concrete API/config/command detail: include a compact table, signatures, option names, command names, exported types, routes, or configuration fields from the supplied evidence.",
    );
  }

  if (isGuideLikePage(input.page) && !hasGuideExample(markdown)) {
    issues.push(
      "Guide-like pages need a concrete source-backed example, command, configuration fragment, numbered workflow, or code block when supplied evidence contains one.",
    );
  }

  if (input.page.sourcePaths.length > 0) {
    const missingPath = input.page.sourcePaths
      .slice(0, 3)
      .find((path) => !markdown.includes(path));
    if (missingPath !== undefined) {
      issues.push(`Mention important source path ${missingPath} in the page prose or source list.`);
    }
  }

  return issues;
}

function canPublishFocusedFallbackDraft(input: {
  draft: ParsedPageDraft;
  issues: string[];
  page: ParsedOutlinePage;
  validSourcePaths: Set<string>;
}): boolean {
  if (!isImportantAgentPrimitivePage(input.page)) return false;
  if (!input.issues.every((issue) => isFallbackSafePageQualityIssue(issue))) return false;

  const markdown = input.draft.markdown;
  if (!markdown.trimStart().startsWith(`# ${input.draft.title}`) && !/^#\s+.+/m.test(markdown)) return false;
  if (countMarkdownHeadings(markdown, 2) < 3) return false;
  if (!/^##\s+Relevant Source Files\b/im.test(markdown)) return false;
  if (!/Sources:/i.test(markdown)) return false;

  const validCitationPaths = getValidCitationPaths(input.draft, input.validSourcePaths);
  if (validCitationPaths.length === 0) return false;
  if (!validCitationPaths.some((path) => markdown.includes(path))) return false;

  const rawWordCount = markdown.split(/\s+/).filter(Boolean).length;
  return rawWordCount >= 300 || hasReferenceDetail(markdown) || hasGuideExample(markdown);
}

function isFallbackSafePageQualityIssue(issue: string): boolean {
  return /page has about \d+ words/i.test(issue) ||
    /Reference-like pages need concrete API\/config\/command detail/i.test(issue);
}

function isImportantAgentPrimitivePage(page: ParsedOutlinePage): boolean {
  const text = `${page.slug} ${page.title} ${page.purpose}`.toLowerCase();
  return /\b(instructions?|skills?|connections?|mcp|openapi|open api|sandbox|subagents?|schedules?|evals?|sessions?|streaming|continuations?|client|sdk|approvals?)\b/.test(
    text,
  ) || /\b(getting[- ]started|quick[- ]?start|first[- ]agent|tutorial|installation|setup|workflow)\b/.test(text);
}

function getMinPageSectionCount(input: {
  documentationSourceCount: number;
  fileCount: number;
  officialDocsLinkCount?: number;
  page: ParsedOutlinePage;
}): number {
  const docsRich = input.documentationSourceCount >= 60 || (input.officialDocsLinkCount ?? 0) >= 60;
  if (!docsRich) return 3;

  const text = `${input.page.slug} ${input.page.title} ${input.page.purpose}`.toLowerCase();
  const broadPage = input.page.slug === "overview" ||
    input.page.slug.endsWith("-overview") ||
    /\b(architecture|concepts?|fundamentals?|getting started|installation|overview|reference|api reference|configuration|security|auth|authentication|database|storage|realtime|routing|rendering|compiler|server components?)\b/.test(text);
  if (broadPage && (input.documentationSourceCount >= 100 || (input.officialDocsLinkCount ?? 0) >= 120)) {
    return 5;
  }

  if (input.fileCount >= 500 || input.documentationSourceCount >= 100 || (input.officialDocsLinkCount ?? 0) >= 120) {
    return 4;
  }

  return 3;
}

function getUnrelatedVisibleSourcePaths(input: {
  draft: ParsedPageDraft;
  markdown: string;
  page: ParsedOutlinePage;
}): string[] {
  const pageText = `${input.page.slug} ${input.page.title} ${input.page.purpose} ${input.page.sourcePaths.join(" ")}`;
  const normalizedPageText = normalizeSlugForComparison(pageText);
  const sourcePaths = new Set(input.page.sourcePaths);
  const targetsLintDocs = /(?:^|-)(?:eslint|lint|lints|rules-of-hooks|exhaustive-deps|component-hook-factories)(?:-|$)/i.test(normalizedPageText);
  const targetsTestingDocs = /(?:^|-)(?:test|tests|testing|act)(?:-|$)/i.test(normalizedPageText);
  const targetsReactDomRootApi = /^react-dom-apis-[a-z0-9-]+$/i.test(input.page.slug);
  const forbidden = [
    {
      allowed: targetsLintDocs,
      pattern: /packages\/eslint-plugin-react-hooks\/[A-Za-z0-9_./-]+/g,
    },
    {
      allowed: targetsTestingDocs,
      pattern: /(?:packages\/)?dom-event-testing-library\/[A-Za-z0-9_./-]+/g,
    },
    {
      allowed: !targetsReactDomRootApi || /(?:server|render-to-|render|resume|prerender)/i.test(normalizedPageText),
      pattern: /packages\/react-dom\/(?:npm\/)?server\.js/g,
    },
    {
      allowed: !targetsReactDomRootApi || /(?:client|create-root|hydrate-root|flush-sync)/i.test(normalizedPageText),
      pattern: /packages\/react-dom\/(?:npm\/)?client\.js/g,
    },
  ];
  const text = [
    input.markdown,
    ...input.draft.citations.map((citation) => citation.path),
  ].join("\n");
  const paths = new Set<string>();

  for (const rule of forbidden) {
    if (rule.allowed) continue;
    for (const match of text.matchAll(rule.pattern)) {
      const path = match[0] ?? "";
      if (path.length > 0 && !sourcePaths.has(path)) paths.add(path);
    }
  }

  return [...paths].sort();
}

function getValidCitationPaths(
  draft: ParsedPageDraft,
  validSourcePaths: Set<string>,
): string[] {
  return [...new Set(
    draft.citations
      .map((citation) => citation.path)
      .filter((path) => validSourcePaths.has(path)),
  )];
}

function getVisibleSourcePaths(input: {
  markdown: string;
  outlineSourcePaths: string[];
  validCitationPaths: string[];
  validSourcePaths: Set<string>;
}): string[] {
  const sourceLines = input.markdown
    .split("\n")
    .filter((line) => /Sources:/i.test(line));
  if (sourceLines.length === 0) return [];

  const candidatePaths = [
    ...input.validCitationPaths,
    ...input.outlineSourcePaths.filter((path) => input.validSourcePaths.has(path)),
  ];
  return [...new Set(candidatePaths.filter((path) =>
    sourceLines.some((line) => line.includes(path)) || input.markdown.includes(path),
  ))];
}

function isReferenceLikePage(page: ParsedOutlinePage): boolean {
  const titleAndSlug = `${page.title} ${page.slug}`;
  const explicitReference = /(api|reference|configuration|config|option|command|route|hook|schema|type|endpoint)/i.test(titleAndSlug);
  if (explicitReference) return true;

  const purposeReference = /(api|reference|configuration|config|option|command|route|hook|schema|type|endpoint)/i.test(page.purpose);
  return purposeReference && !isGuideLikePage(page);
}

function isGuideLikePage(page: ParsedOutlinePage): boolean {
  return /(getting started|quickstart|setup|install|guide|workflow|usage|tutorial|example|cookbook|recipe|migration|upgrade|troubleshoot|troubleshooting)/i.test(
    `${page.title} ${page.slug} ${page.purpose}`,
  );
}

function hasReferenceDetail(markdown: string): boolean {
  const tableRows = markdown.match(/^\|.+\|$/gm)?.length ?? 0;
  const codeFences = markdown.match(/^```/gm)?.length ?? 0;
  const inlineCode = markdown.match(/`[^`\n]+`/g)?.length ?? 0;
  const subheadings = markdown.match(/^###\s+/gm)?.length ?? 0;
  const optionBullets = markdown.match(/^\s*[-*]\s+`[^`\n]+`/gm)?.length ?? 0;

  return tableRows >= 3 || codeFences >= 2 || inlineCode >= 8 || subheadings >= 3 || optionBullets >= 4;
}

function hasGuideExample(markdown: string): boolean {
  return (
    (markdown.match(/^```/gm)?.length ?? 0) >= 2 ||
    /^\s*\d+\.\s+/m.test(markdown) ||
    /(^|\n)\s*(pnpm|npm|yarn|bun|cargo|rustup|npx|node|git|curl|vercel)\s+/i.test(markdown) ||
    /(example|sample|workflow|step|terminal|command|configuration|config)/i.test(markdown)
  );
}

function hasEnoughSubstantiveDetail(input: {
  markdown: string;
  minWords: number;
  wordCount: number;
}): boolean {
  const minimumNearMissWords = input.minWords >= 900
    ? input.minWords - 25
    : Math.floor(input.minWords * 0.9);
  if (input.wordCount < minimumNearMissWords) return false;

  return (
    countMarkdownHeadings(input.markdown, 2) >= 3 &&
    /Sources:/i.test(input.markdown) &&
    (hasReferenceDetail(input.markdown) || hasGuideExample(input.markdown))
  );
}

function getMissingGeneratedPageSlugs(
  outlinePages: ParsedOutlinePage[],
  generatedPages: ParsedPageDraft[],
): string[] {
  const generatedSlugs = new Set(generatedPages.map((page) => normalizeSlugForComparison(page.slug)));
  return outlinePages
    .map((page) => normalizeSlugForComparison(page.slug))
    .filter((slug) => !generatedSlugs.has(slug));
}

function findNavigationNodeWithSlugAndChildren(nodes: ParsedOutline["navigation"]): string | null {
  for (const node of nodes) {
    if (node.slug !== undefined && node.children !== undefined && node.children.length > 0) {
      return node.title;
    }
    const childMatch = node.children === undefined ? null : findNavigationNodeWithSlugAndChildren(node.children);
    if (childMatch !== null) return childMatch;
  }
  return null;
}

function countWords(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/^.*\bSources:\s*.*$/gim, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g, " ")
    .match(/[A-Za-z0-9][A-Za-z0-9'-]*/g)?.length ?? 0;
}

function countMarkdownHeadings(markdown: string, depth: number): number {
  const marker = "#".repeat(depth);
  const pattern = new RegExp(`^${marker}\\s+`, "gm");
  return markdown.match(pattern)?.length ?? 0;
}

function getPriorityRank(priority: ParsedOutlinePage["priority"]): number {
  switch (priority) {
    case "required":
      return 3;
    case "recommended":
      return 2;
    case "optional":
      return 1;
  }
}

function countDocumentationSourceFiles(files: PreparedRepositoryWorkspace["fileInventory"]): number {
  return files.filter((file) => isDocumentationSourcePath(file.path)).length;
}

function isDocumentationSourcePath(path: string): boolean {
  if (isInternalPlanningDocumentationPath(path)) return false;

  const normalized = path.toLowerCase();
  return (
    /^readme(\.mdx?)?$/.test(normalized) ||
    /(^|\/)readme(\.mdx?)?$/.test(normalized) ||
    /(^|\/)(llms\.txt|sitemap\.md|meta\.json|mint\.json|navigation\.(json|ts|tsx|js|jsx))$/.test(normalized) ||
    /^(docs|content\/docs|site\/docs|website\/docs)\//.test(normalized) ||
    /(^|\/)(docs|content\/docs|site\/docs|website\/docs)\/.+\.(md|mdx|mdoc|txt|json|yaml|yml)$/.test(normalized)
  );
}

function isInternalPlanningOutlinePage(page: ParsedOutlinePage): boolean {
  const text = `${page.slug} ${page.title} ${page.purpose}`.toLowerCase();
  return (
    (
      page.sourcePaths.length > 0 &&
      page.sourcePaths.every(isInternalPlanningDocumentationPath)
    ) ||
    /\b(ai sdk quality runs?|quality runs?|dx feedback|feedback deep dive|open source deepwiki|deepwiki|research plan|implementation plan|indexing and workflow plan|auto update plan|harness gaps?|quality follow-?up|completed plans?|active plans?|gap analysis|porting notes?|benchmark harness|scratchpad|todo)\b/.test(text)
  );
}

function isOverviewPage(page: ParsedOutlinePage): boolean {
  return normalizeSlugForComparison(page.slug) === "overview";
}

function getDuplicateNormalizedSlugs(pages: ParsedOutlinePage[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const page of pages) {
    const slug = normalizeSlugForComparison(page.slug);
    if (slug.length === 0) continue;
    if (seen.has(slug)) {
      duplicates.add(slug);
    } else {
      seen.add(slug);
    }
  }

  return [...duplicates].sort();
}

function isRepositoryOverviewPage(page: ParsedOutlinePage, repoName: string): boolean {
  const title = normalizeSlugForComparison(page.title);
  const repo = normalizeSlugForComparison(repoName);

  return (
    title === "overview" ||
    title === "introduction" ||
    title === "repository-overview" ||
    title === "project-overview" ||
    (repo.length > 0 && (title === `${repo}-overview` || title === `${repo}-documentation-overview`))
  );
}

function pruneNavigation(
  nodes: ParsedOutline["navigation"],
  selectedSlugs: Set<string>,
): ParsedOutline["navigation"] {
  return nodes.flatMap((node) => {
    const children = node.children === undefined ? undefined : pruneNavigation(node.children, selectedSlugs);
    const slug = node.slug === undefined ? undefined : normalizeSlugForComparison(node.slug);
    const hasSelectedSlug = slug !== undefined && selectedSlugs.has(slug);

    if (!hasSelectedSlug && (children === undefined || children.length === 0)) {
      return [];
    }

    const normalized = { ...node };
    if (children !== undefined) normalized.children = children;
    return [normalized];
  });
}

async function readPageContext(input: {
  baselineContextSnippets: ContextSnippet[];
  page: ParsedOutlinePage;
  snapshot: PreparedRepositoryWorkspace;
}): Promise<ContextSnippet[]> {
  const snippets = new Map<string, ContextSnippet>();
  const fileInventory = new Map(input.snapshot.fileInventory.map((file) => [file.path, file]));

  for (const path of input.page.sourcePaths) {
    if (snippets.size >= MAX_PAGE_SOURCE_FILES) break;

    const file = fileInventory.get(path);
    if (file === undefined || file.size > MAX_PAGE_CONTEXT_CHARS * 8) continue;

    try {
      const text = await readGitHubRepoFile(input.snapshot, path);
      snippets.set(path, {
        path,
        text: text.slice(0, MAX_PAGE_CONTEXT_CHARS),
      });
    } catch {
      // Source files are best-effort context; validation still requires visible source paths.
    }
  }

  for (const snippet of input.baselineContextSnippets) {
    if (snippets.size >= MAX_PAGE_SOURCE_FILES) break;
    if (isFoundationalContextPath(snippet.path)) {
      snippets.set(snippet.path, {
        path: snippet.path,
        text: snippet.text.slice(0, MAX_PAGE_CONTEXT_CHARS),
      });
    }
  }

  for (const snippet of input.baselineContextSnippets) {
    if (snippets.size >= MAX_PAGE_SOURCE_FILES) break;
    if (snippets.has(snippet.path)) continue;
    if (!isRelevantContextPath(snippet.path, input.page)) continue;
    snippets.set(snippet.path, {
      path: snippet.path,
      text: snippet.text.slice(0, MAX_PAGE_CONTEXT_CHARS),
    });
  }

  if (snippets.size === 0) {
    for (const snippet of input.baselineContextSnippets.slice(0, 4)) {
      snippets.set(snippet.path, {
        path: snippet.path,
        text: snippet.text.slice(0, MAX_PAGE_CONTEXT_CHARS),
      });
    }
  }

  return [...snippets.values()];
}

async function runStructuredIndexingWorker<StructuredOutput>(input: {
  indexJobId: string;
  maxOutputTokens?: number;
  message: string;
  outputName: string;
  phase: string;
  schema: z.ZodType<StructuredOutput>;
  state: IndexAdapterState;
  timeoutMs: number | undefined;
}): Promise<{
  output: StructuredOutput;
  responseId: string | undefined;
}> {
  const model = getIndexModel();
  logIndexing("worker-starting", input.state, {
    model,
    messageLength: input.message.length,
    workerMode: "structured",
    workerPhase: input.phase,
  });

  const heartbeat = startWorkerHeartbeat({
    indexJobId: input.indexJobId,
    phase: input.phase,
    state: input.state,
  });

  try {
    const result = await withOptionalTimeout(
      generateText({
        instructions:
          "You generate source-grounded OpenWiki documentation data. Return only the requested structured output. Do not call tools.",
        maxOutputTokens: input.maxOutputTokens,
        model,
        output: Output.object({
          name: input.outputName,
          schema: input.schema,
        }),
        prompt: input.message,
      }),
      input.timeoutMs,
      `Indexing worker "${input.phase}" timed out before returning structured output.`,
    );

    logIndexing("event", input.state, {
      finishReason: result.finishReason,
      outputTokens: result.usage.outputTokens,
      promptTokens: result.usage.inputTokens,
      responseId: result.response.id,
      totalTokens: result.usage.totalTokens,
      workerMode: "structured",
      workerPhase: input.phase,
    });

    return {
      output: result.output,
      responseId: result.response.id,
    };
  } finally {
    heartbeat.stop();
  }
}

function startWorkerHeartbeat(input: {
  indexJobId: string;
  phase: string;
  state: IndexAdapterState;
}): { stop: () => void } {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const interval = setInterval(() => {
    if (stopped || inFlight !== undefined) return;
    inFlight = touchIndexJob(input.indexJobId)
      .catch((error: unknown) => {
        logIndexing("event", input.state, {
          error: error instanceof Error ? error.message : "Unknown heartbeat error.",
          eventType: "worker.heartbeat.failed",
          workerPhase: input.phase,
        });
      })
      .finally(() => {
        inFlight = undefined;
      });
  }, getWorkerHeartbeatMs());

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

async function ensureIndexJobIsStillRunning(indexJobId: string): Promise<void> {
  const job = await getIndexJob(indexJobId);
  if (job === null) {
    throw new Error("Indexing job no longer exists.");
  }
  if (job.status !== "running" && job.status !== "pending") {
    throw new Error(`Indexing job is no longer active (${job.status}).`);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function withOptionalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  message: string,
): Promise<T> {
  if (timeoutMs === undefined) return await promise;
  return await withTimeout(promise, timeoutMs, message);
}

function getOutlineWorkerTimeoutMs(): number | undefined {
  const configured = Number.parseInt(process.env.OPENWIKI_OUTLINE_WORKER_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_OUTLINE_WORKER_TIMEOUT_MS;
}

function getPageWorkerTimeoutMs(): number | undefined {
  const configured = Number.parseInt(process.env.OPENWIKI_PAGE_WORKER_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_PAGE_WORKER_TIMEOUT_MS;
}

function getIndexModel(): string {
  return getOpenWikiIndexModel();
}

function getWorkerHeartbeatMs(): number {
  const configured = Number.parseInt(process.env.OPENWIKI_WORKER_HEARTBEAT_MS ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_WORKER_HEARTBEAT_MS;
}

function isFoundationalContextPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    /^readme(\.mdx?)?$/.test(normalized) ||
    normalized === "package.json" ||
    normalized === "pnpm-workspace.yaml" ||
    normalized === "turbo.json" ||
    normalized === "lerna.json" ||
    normalized === "cargo.toml"
  );
}

function isRelevantContextPath(path: string, page: ParsedOutlinePage): boolean {
  const normalizedPath = path.toLowerCase();
  const terms = `${page.slug} ${page.title} ${page.purpose}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4);

  return terms.some((term) => normalizedPath.includes(term));
}

function normalizeSlugForComparison(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getPageWorkerConcurrency(): number {
  const configured = Number.parseInt(process.env.OPENWIKI_PAGE_WORKER_CONCURRENCY ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, 16);
  }

  return DEFAULT_PAGE_WORKER_CONCURRENCY;
}
