import type { PreparedRepositoryWorkspace } from "../github-repo.js";
import {
  formatOfficialDocsIndexForPrompt,
  type OfficialDocsIndex,
} from "./official-docs.js";
import type { ParsedOutline, ParsedOutlinePage, ParsedPageDraft } from "./output.js";
import {
  getMaxOutlinePagesForEvidence,
  getMinOutlinePagesForEvidence,
} from "./quality-targets.js";
import { isInternalPlanningDocumentationPath } from "./source-paths.js";
import type { ContextSnippet } from "./types.js";

const MAX_INVENTORY_SAMPLE_FILES = 180;
const MAX_DOCUMENTATION_SOURCE_CANDIDATES = 60;
const MAX_DOCUMENTATION_IA_GROUPS = 32;
const MAX_DOCUMENTATION_IA_PATHS = 140;
const MAX_DOCUMENTATION_IA_GROUP_EXAMPLES = 8;
const MAX_PUBLIC_SURFACE_CANDIDATES = 50;
const MAX_REPOSITORY_MAP_GROUPS = 30;
const MAX_GROUP_EXAMPLES = 5;
const MAX_OUTLINE_CONTEXT_SNIPPETS = 16;
const MAX_OUTLINE_CONTEXT_CHARS = 1_200;
const MAX_PAGE_CONTEXT_SNIPPETS = 8;
const MAX_PAGE_CONTEXT_CHARS = 4_000;

export function createIndexingPrompt(input: {
  contextSnippets: ContextSnippet[];
  officialDocsIndex?: OfficialDocsIndex;
  snapshot: PreparedRepositoryWorkspace;
}): string {
  const { contextSnippets, officialDocsIndex, snapshot } = input;
  return [
    "Task: index repository for OpenWiki.",
    "",
    "Use the indexing parent-run instructions from your system context.",
    "The repository has already been deterministically hydrated into the sandbox; use the evidence below to plan and draft the wiki.",
    "",
    "Quality target:",
    "- Generate a real first-party documentation tree, not a list of files or a few shallow summaries.",
    "- Prefer reader journeys over repository topology: start with what the project is for, then setup/getting started, core concepts, common tasks, API/reference material, examples, troubleshooting, and contributor/operations notes when the source supports them.",
    "- When the repository contains first-party docs source, treat those docs as the primary evidence for reader-facing information architecture. Use implementation source to deepen and verify those pages, not to replace them with repository inventory.",
    "- Ignore internal planning/status docs such as docs/active, docs/completed, feedback notes, gap analyses, quality runs, research plans, and implementation plans when selecting public wiki pages.",
    "- For large repositories with limited user-facing docs source, aim for mature system sections such as architecture, package ecosystem, build/compilation, runtime behavior, routing, caching, development infrastructure, testing, CI/CD, examples, and glossary/reference material when the evidence supports them.",
    "- Prefer pages that explain systems and relationships across source files. Use source paths as grounding, not as the structure itself.",
    "",
    `Repository: ${snapshot.owner}/${snapshot.repo}`,
    `Repository URL: ${snapshot.url}`,
    `Default branch: ${snapshot.defaultBranch}`,
    `Commit SHA: ${snapshot.commitSha}`,
    `Indexed useful files: ${snapshot.fileInventory.length}`,
    `Skipped files: ${snapshot.skippedFiles.length}`,
    `Wiki depth target: ${createWikiDepthTarget({
      files: snapshot.fileInventory,
      officialDocsIndex,
    })}`,
    `Prepared workspace: /workspace/${snapshot.workspacePath}`,
    `Workspace manifest: /workspace/${snapshot.workspacePath}/.openwiki/manifest.json`,
    "",
    "Repository map:",
    createRepositoryMap(snapshot.fileInventory),
    "",
    "Important file inventory sample:",
    createInventorySample(snapshot.fileInventory),
    "",
    "Documentation source candidates:",
    createDocumentationSourceCandidateList(snapshot.fileInventory),
    "",
    "First-party docs information architecture hints:",
    createDocumentationInformationArchitecture(snapshot.fileInventory),
    "",
    "Official docs index discovered from repository links:",
    formatOfficialDocsIndexForPrompt(officialDocsIndex),
    "",
    "Public surface candidates:",
    createPublicSurfaceCandidateList(snapshot.fileInventory),
    "",
    "Context snippets:",
    contextSnippets.length === 0
      ? "- No small priority files were available."
      : contextSnippets.map((snippet) => `--- ${snippet.path} ---\n${snippet.text}`).join("\n\n"),
  ].join("\n");
}

export function createOutlinePrompt(input: {
  contextSnippets: ContextSnippet[];
  officialDocsIndex?: OfficialDocsIndex;
  qualityFeedback?: string;
  snapshot: PreparedRepositoryWorkspace;
}): string {
  const { contextSnippets, officialDocsIndex, snapshot } = input;
  return [
    "Task: index repository for OpenWiki.",
    "Phase: outline-only.",
    "",
    "Return only the outline JSON object. Do not return published page markdown.",
    input.qualityFeedback === undefined
      ? ""
      : `Quality feedback from the deterministic validator: ${input.qualityFeedback}`,
    "",
    "Outline quality contract:",
    "- Build a first-party documentation information architecture, not a flat file list.",
    "- Organize for readers learning the project: Overview/Why, Getting Started, Core Concepts, Guides or Workflows, API/Reference, Examples/Cookbook, Troubleshooting, and Contributor/Operations sections when source evidence supports those page types.",
    "- If docs source exists, infer the wiki shape from that reader-facing docs structure first. Prefer tutorial/how-to/reference/glossary/migration/troubleshooting pages over repository, monorepo, CI, release, or contributor pages unless those are clearly the documented public audience.",
    "- If an official docs index is supplied, treat it as the strongest information-architecture signal. Preserve its major sections and enough leaf-level topics that the generated wiki feels comparable in breadth to the official documentation.",
    "- Translate official-docs major sections into sibling sidebar folders. For example, React-like docs with Get Started, Learn, and Reference should keep those as major folders; Next-like docs with Getting Started, Guides, and API Reference should not be collapsed into one project overview.",
    "- When the official docs index is broad, most pages should correspond to public official-docs topics. Do not spend the sidebar budget on internal research notes, porting logs, gap analyses, benchmark harnesses, or implementation project logs unless the official docs index explicitly includes matching reader-facing pages.",
    "- Do not turn internal planning/status docs into wiki pages. Paths under docs/active, docs/completed, or files named feedback, gap, quality run, research plan, implementation plan, workflow plan, or auto-update plan are implementation notes, not public docs IA.",
    "- Broad official docs indexes often include second-level families such as Directives, Components, File-system conventions, Functions, Configuration, CLI, Adapters, Authentication, Testing, Migrations, Providers, Models, Storage, Realtime, and Vector Search. Preserve those families as focused pages or nested folders when they appear repeatedly; do not flatten them into one API or Guides page.",
    "- For agent frameworks and developer-agent toolkits, preserve core primitives as first-class docs topics when source evidence supports them: instructions, agent configuration, tools and approvals, skills, channels, connections, MCP/OpenAPI, sandbox, subagents, schedules, evals, sessions and streaming, frontend/client integrations, hooks/instrumentation, deployment/auth, CLI/reference, and tutorials.",
    "- Do not collapse agent-framework primitives into one generic capabilities, architecture, or adjacent settings page. If the first-party docs contain separate primitive pages, plan separate OpenWiki pages or section leaves for those primitives.",
    "- For docs-rich agent frameworks, use reader-facing section groups such as Start Here, Tutorials, Core Concepts, Authoring Agents, Runtime Capabilities, Channels and Clients, Connections, Evals and Observability, and Deployment and Reference instead of leaving primitive pages as one long root-level list.",
    "- Use the first-party docs information architecture hints as the strongest signal for docs-rich repositories. Mirror the source docs' category spine at a useful OpenWiki granularity: introduction/getting started, concepts/foundations, guides/workflows, API/reference, examples/cookbook, migration/troubleshooting, and contributor/operations material when present.",
    "- For mature frameworks and platform libraries with official docs indexes, avoid compressing whole families like hooks, components, APIs, file conventions, directives, configuration, routing, data fetching, caching, deployment, and migration into one or two overview pages. Create focused leaves for the important public surfaces, often 50+ pages when the docs index is broad enough.",
    "- For SDKs, libraries, CLIs, frameworks, and developer tools, include a learning path plus precise reference pages for public APIs, commands, hooks, transports, providers, configuration, or extension points found in source.",
    "- Prioritize the public contract readers use over implementation inventory. If many adapters, integrations, plugins, or packages implement the same contract, group them into ecosystem/reference pages instead of spending the sidebar on one page per implementation.",
    "- Do not create separate pages for PostCSS, Vite, Webpack, browser, or CLI integrations unless each has substantial independent docs. For medium repositories, group related integrations into one source-backed Integrations page.",
    "- Include focused API/reference leaves for public entrypoints discovered from exports, root/package READMEs, package metadata, CLI bins, route handlers, or top-level `index`/`main` modules. Use generic titles based on the discovered surface, not repository-specific assumptions.",
    "- Use folder-like parent navigation nodes for major documentation areas. In the returned JSON, folder nodes must use `slug: null`; only leaf page nodes should have a string `slug`. Nodes that can contain children should include a `children` array, using `[]` for leaf-like nodes at that level.",
    "- Do not wrap every page in one generic root folder. Docs-rich repositories need multiple sibling navigation folders such as Getting Started, Concepts, Guides, API Reference, Examples, and Operations when source evidence supports them.",
    "- For broad docs trees, use deeper nested section folders when one level would flatten product areas, guide families, API families, examples, and operations into an undifferentiated list.",
    "- Slugs must be unique after normalization. Use `overview` only for the repository-level landing page; section overview pages must use specific slugs such as `channels-overview`, `tools-overview`, or `client-overview`.",
    "- Do not include duplicate public-docs topics with both a canonical slug and a group-prefixed slug. For example, choose one page for `quick-start`, not both `quick-start` and `get-started-quick-start-quick-start`; use the saved page budget for another distinct official docs leaf.",
    "- Avoid thin setup landing pages when richer focused setup leaves are present. For example, do not keep a generic `creating-a-react-app` page if the outline already includes focused pages such as build from scratch, add to an existing project, installation, setup, editor setup, or TypeScript.",
    "- Preserve namespaces for generic reference pages. If a generic page title such as `Hooks`, `Components`, `APIs`, or `Directives` comes from a URL namespace like `react-dom`, `react-dom-server`, or `eslint-plugin-react-hooks`, include that namespace in the slug and navigation title.",
    `- Include a repository-level landing page with slug \`overview\` and a generic title such as \`Overview\`, \`Repository Overview\`, or \`${snapshot.repo} Overview\`. Do not use slug \`overview\` for a subsystem, package, channel, tool, or section page.`,
    "- Large monorepos must include enough pages to be useful. When first-party docs source exists, prioritize its reader-facing tutorials, guides, concepts, and references. When it does not, cover overview, repository architecture, package/app/crate ecosystems, build/compiler pipeline, runtime/server behavior, routing/API surface, testing/CI, examples/dev workflow, and other major source-backed systems.",
    "- For docs sites, the sidebar must read like a real docs site: multiple section folders with focused leaf pages. Avoid one long, shallow list under a single title like `<project> Documentation`.",
    "- Every page must include `sourcePaths` that directly support the page. Prefer multiple source paths for subsystem pages.",
    "- Do not under-generate. If the repository map shows many products, packages, apps, crates, docs areas, examples, or toolchains, produce a multi-folder tree with enough focused pages for a useful docs sidebar. Docs-site-scale repositories should feel comparable to first-party docs, not like a short overview.",
    "- Use the high end of the wiki depth target only when the source evidence contains enough distinct reader-facing topics. Extra pages must be justified by real docs/source clusters, not by splitting one concept into thin duplicates.",
    "- Stay within the wiki depth target above. For broad first-party docs trees, choose the highest-value reader paths across every major docs section; do not spend the page budget on one family while omitting other important reader journeys.",
    "- Avoid page titles that are only directory names. Name pages after reader tasks, concepts, or public surfaces unless the directory is itself a product boundary.",
    "",
    `Repository: ${snapshot.owner}/${snapshot.repo}`,
    `Repository URL: ${snapshot.url}`,
    `Default branch: ${snapshot.defaultBranch}`,
    `Commit SHA: ${snapshot.commitSha}`,
    `Indexed useful files: ${snapshot.fileInventory.length}`,
    `Skipped files: ${snapshot.skippedFiles.length}`,
    `Wiki depth target: ${createWikiDepthTarget({
      files: snapshot.fileInventory,
      officialDocsIndex,
    })}`,
    "",
    "Repository map:",
    createRepositoryMap(snapshot.fileInventory),
    "",
    "Important file inventory sample:",
    createInventorySample(snapshot.fileInventory),
    "",
    "Documentation source candidates:",
    createDocumentationSourceCandidateList(snapshot.fileInventory),
    "",
    "First-party docs information architecture hints:",
    createDocumentationInformationArchitecture(snapshot.fileInventory),
    "",
    "Official docs index discovered from repository links:",
    formatOfficialDocsIndexForPrompt(officialDocsIndex),
    "",
    "Public surface candidates:",
    createPublicSurfaceCandidateList(snapshot.fileInventory),
    "",
    "Selected outline evidence snippets:",
    formatContextSnippets(contextSnippets, {
      maxCharsPerSnippet: MAX_OUTLINE_CONTEXT_CHARS,
      maxSnippets: MAX_OUTLINE_CONTEXT_SNIPPETS,
    }),
  ].join("\n");
}

export function createPageGenerationPrompt(input: {
  contextSnippets: ContextSnippet[];
  minimumWordCount: number;
  officialDocsSnippets: ContextSnippet[];
  outline: ParsedOutline;
  pages: ParsedOutlinePage[];
  previousDrafts?: ParsedPageDraft[];
  qualityFeedback?: string;
  repository: {
    commitSha: string;
    defaultBranch: string;
    fullName: string;
    url: string;
  };
  repositoryMap: string;
}): string {
  const largeWiki = input.outline.pages.length >= 50;
  const targetWordCount = largeWiki
    ? input.minimumWordCount >= 900
      ? input.minimumWordCount + 250
      : input.minimumWordCount + 150
    : input.minimumWordCount >= 1_000
      ? input.minimumWordCount + 450
      : input.minimumWordCount >= 900
        ? input.minimumWordCount + 300
        : input.minimumWordCount + 200;
  const maximumWordCount = targetWordCount + (largeWiki ? 200 : 300);

  return [
    "Task: index repository for OpenWiki.",
    "Phase: page-generation.",
    "",
    "Return only the page-generation JSON object. Generate exactly one page object for each requested outline page.",
    "Use `markdownLines` instead of `markdown`: every markdown line must be a separate JSON string in the array.",
    "Do not place raw multiline markdown inside a JSON string.",
    "Avoid backslash escapes in markdown text unless they are valid JSON escapes. Prefer repository paths with forward slashes.",
    input.qualityFeedback === undefined
      ? ""
      : `Quality feedback from the deterministic validator: ${input.qualityFeedback}`,
    "",
    "Page quality contract:",
    "- Every page must start with exactly one `# Title` line.",
    "- Every page must include at least three `##` sections. Use source-backed sections such as `## Purpose and Scope`, `## Relevant Source Files`, `## System-to-Code Mapping`, `## Execution Flow`, `## API Components`, `## Implementation Details`, `## Testing Signals`, or `## CI/CD Signals` when supported.",
    "- Write like first-party developer docs: explain the reader problem, define terms before using them, show how the pieces fit together, and end with concrete next steps or related pages when useful.",
    "- A page with only a short introduction, a few source bullets, and a compact mapping table is invalid. Write enough normal paragraph prose that the page remains useful after tables, lists, code, citations, and source-path lines are removed.",
    largeWiki
      ? "- Depth must come from normal explanatory prose. For docs-rich 50+ page wikis, keep focused leaf pages bounded: write five to seven substantial paragraphs of 60-110 words each outside code fences, inline code, markdown tables, source-path bullets, and visible Sources lines. Tables, code, path lists, headings, and citations are helpful but do not count toward the prose depth target."
      : "- Depth must come from normal explanatory prose. For docs-rich pages, write at least eight substantial paragraphs of 60-120 words each outside code fences, inline code, markdown tables, source-path bullets, and visible Sources lines. Tables, code, path lists, headings, and citations are helpful but do not count toward the prose depth target.",
    "- Even for compact repositories, satisfy the prose target with full paragraphs, not only headings, bullets, tables, code blocks, and source-path lists. A 450-word page should usually have at least five source-backed narrative paragraphs before or around its compact reference material.",
    "- Do not compress broad overview, getting-started, guide, or concept pages into a short intro plus a mapping table. Give the reader a docs-quality narrative: what problem the page solves, how the workflow fits into the project, how public APIs or source modules participate, what decisions or constraints matter, and what to read next.",
    "- For getting-started pages in agent frameworks, SDKs, CLIs, and developer platforms, include a `## Core Primitives` or equivalent section when supported by the outline or docs evidence. Briefly orient readers to the important building blocks before next steps, especially instructions, tools, skills, channels, connections (including MCP and OpenAPI), sandbox, subagents, schedules, sessions/streaming, hooks, and config when those appear in the project docs.",
    "- If official docs snippets mention Connections, MCP, or OpenAPI, do not omit them from getting-started, overview, or capability pages. Explain how they differ from local tools and where a reader should go next.",
    "- Use official docs evidence to match first-party terminology, examples, sequencing, and reader tasks. Treat it as supplemental product-documentation evidence, not as repository source citation evidence.",
    "- When source evidence includes existing docs pages, preserve their reader-facing intent and terminology. Use code paths as grounding for behavior and source mapping instead of turning the page into repository archaeology.",
    "- For guide pages, include task-oriented flow and source-backed examples. For reference pages, be precise about public entry points, inputs, outputs, options, and behavior. Keep those modes distinct.",
    "- For getting-started, guide, workflow, example, cookbook, migration, and troubleshooting pages, include concrete commands, code snippets, config fragments, file paths, or step-by-step flows when supplied evidence contains them.",
    "- Do not let package catalogs replace API documentation. When a page covers an ecosystem of similar implementations, explain the shared public contract first, then call out implementation-specific differences.",
    "- If the requested page is an API, reference, configuration, command, route, hook, provider, adapter, model, vector/search, auth, storage, database, realtime, or options page, include a compact reference section with concrete names, signatures, options, routes, commands, config fields, exported entry points, or source-level contracts visible in the supplied source evidence.",
    "- Avoid generic statements that could fit any repository. Name real packages, crates, modules, commands, options, routes, file conventions, public functions, exported types, or runtime phases from the supplied evidence.",
    "- Do not say a source file is missing, omitted, unavailable, or not directly included. If evidence is thin, constrain the claim and keep missing-source notes in `coverageNotes`, not page prose.",
    "- For large repositories, write thorough subsystem documentation. Do not return stub summaries or short bullet lists.",
    `- Each generated page must be at least ${input.minimumWordCount} words of substantive source-grounded prose, and should target roughly ${targetWordCount} prose words when the supplied evidence is rich. The validator excludes fenced code blocks, inline code, URLs, source path strings, visible Sources lines, JSON syntax, and citation metadata from the prose word count. Do not exceed ${maximumWordCount} prose words for any one page. Use this space for explanations, flows, examples, source mapping, and reference detail rather than filler.`,
    "- If validator feedback says the page is short, rewrite the draft by adding concrete source-backed detail in long-form prose: more precise terminology, workflow steps, API/config explanations, examples, system-to-code mapping, edge cases, and related-page guidance. Add whole paragraphs or useful subsections; do not resubmit the same compact draft or only lightly rephrase it.",
    "- If a previous draft failed to return structured JSON or hit an output length limit, produce a complete but bounded page in the requested word range instead of expanding further.",
    "- For docs-rich repositories, most pages should have four to six useful sections with multi-paragraph explanations, not just three short sections.",
    "- Include a `## Relevant Source Files` section with compact bullets explaining why each important source path matters.",
    "- Copy important repository source paths exactly as provided in the requested page `sourcePaths`; do not shorten, rename, wrap, or paraphrase path strings in the `## Relevant Source Files` section or visible `Sources:` lines.",
    "- Do not add unrelated repository files to `## Relevant Source Files`, visible `Sources:` lines, prose, or structured citations just because they are valid paths in the repository. If a path is not in the requested page `sourcePaths` and does not directly support this page's reader task, leave it out.",
    "- Ground concrete claims in source paths using visible `Sources: path/a.ts, path/b.ts` lines in the prose.",
    "- Include structured citations for the same concrete source paths used in visible Sources lines.",
    "- Citation objects must include `startLine` and `endLine`; use `null` for either value when exact line numbers are unknown.",
    "- Prefer explanatory paragraphs plus compact bullets. Avoid one-sentence sections, generic claims, and file-by-file narration.",
    "",
    `Repository: ${input.repository.fullName}`,
    `Repository URL: ${input.repository.url}`,
    `Default branch: ${input.repository.defaultBranch}`,
    `Commit SHA: ${input.repository.commitSha}`,
    `Repository summary: ${input.outline.summary}`,
    "",
    "Source evidence usage:",
    "- Use the supplied snippets first. They are selected from the outline's sourcePaths and repository-level context.",
    "- Use official docs snippets for reader-facing explanations, tutorial flow, API naming, and conceptual framing when they are relevant.",
    "- Do not cite `official-docs:` paths as structured citations. Structured citations and visible `Sources:` lines must use concrete repository file paths from the targeted source evidence.",
    "- Do not call tools during normal page drafting.",
    "- Only use the default bash tool as a last resort when a required source path is missing from the supplied evidence and a hydrated workspace is available.",
    "- If bash is required, make exactly one short, read-only command scoped to known files/directories.",
    "- Do not run broad repository scans, package installs, dev servers, tests, long-running commands, or remote GitHub fetches.",
    "",
    "Repository map summary:",
    input.repositoryMap.split("\n").slice(0, 20).join("\n"),
    "",
    "Full outline page list:",
    input.outline.pages.map((page) => `- ${page.slug}: ${page.title} - ${page.purpose}`).join("\n"),
    "",
    "Requested pages for this worker:",
    JSON.stringify(input.pages, null, 2),
    "",
    input.previousDrafts === undefined
      ? ""
      : ["Previous rejected drafts:", JSON.stringify(input.previousDrafts, null, 2), ""].join("\n"),
    "Official docs evidence for this page:",
    input.officialDocsSnippets.length === 0
      ? "- No page-specific official docs snippets were selected."
      : formatContextSnippets(input.officialDocsSnippets, {
        maxCharsPerSnippet: 2_400,
        maxSnippets: 3,
      }),
    "",
    "Targeted source evidence snippets:",
    formatContextSnippets(input.contextSnippets, {
      maxCharsPerSnippet: MAX_PAGE_CONTEXT_CHARS,
      maxSnippets: MAX_PAGE_CONTEXT_SNIPPETS,
    }),
  ].join("\n");
}

function createDocumentationSourceCandidateList(
  files: PreparedRepositoryWorkspace["fileInventory"],
): string {
  const candidates = [...files]
    .filter((file) => isDocumentationSourceCandidate(file.path))
    .sort(
      (a, b) =>
        scoreDocumentationSourceCandidate(b.path) -
          scoreDocumentationSourceCandidate(a.path) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, MAX_DOCUMENTATION_SOURCE_CANDIDATES);

  if (candidates.length === 0) {
    return "- No obvious first-party documentation source was discovered from paths alone.";
  }

  return candidates.map((file) => `- ${file.path} (${file.language}, ${file.size} bytes)`).join("\n");
}

function createWikiDepthTarget(input: {
  files: PreparedRepositoryWorkspace["fileInventory"];
  officialDocsIndex?: OfficialDocsIndex;
}): string {
  const { files, officialDocsIndex } = input;
  const documentationSourceCount = files.filter((file) => isDocumentationSourceCandidate(file.path)).length;
  const minPages = getMinOutlinePagesForEvidence({
    documentationSourceCount,
    fileCount: files.length,
    officialDocsLinkCount: officialDocsIndex?.linkCount,
  });
  const maxPages = getMaxOutlinePagesForEvidence({
    documentationSourceCount,
    fileCount: files.length,
    officialDocsLinkCount: officialDocsIndex?.linkCount,
  });

  if (officialDocsIndex !== undefined) {
    return [
      `An official docs index with ${officialDocsIndex.linkCount} linked docs pages was discovered at ${officialDocsIndex.sourceUrl}.`,
      `${documentationSourceCount} repository docs source files were also found.`,
      `Plan ${minPages}-${maxPages} source-backed pages across a docs-site-quality sidebar.`,
      "Preserve the official docs' major section spine and split broad API/guide families into focused leaves. Use the upper end only when the docs index has enough independently useful reader topics.",
    ].join(" ");
  }

  if (documentationSourceCount >= 12) {
    return [
      `${documentationSourceCount} first-party docs source files were found.`,
      `Plan ${minPages}-${maxPages} source-backed pages across a multi-folder docs sidebar.`,
      "Use the source docs' own category spine and avoid compressing mature docs into broad overview pages. Use the upper end only when the repository has enough independently useful reader topics.",
    ].join(" ");
  }

  return `Plan ${minPages}-${maxPages} focused source-backed pages; keep the wiki compact unless the evidence shows distinct reader-facing systems.`;
}

function createDocumentationInformationArchitecture(
  files: PreparedRepositoryWorkspace["fileInventory"],
): string {
  const docs = [...files]
    .filter((file) => isDocumentationSourceCandidate(file.path))
    .sort(
      (a, b) =>
        scoreDocumentationIaPath(b.path) - scoreDocumentationIaPath(a.path) ||
        compareDocumentationPaths(a.path, b.path),
    )
    .slice(0, MAX_DOCUMENTATION_IA_PATHS);

  if (docs.length === 0) {
    return "- No first-party documentation tree was discovered from paths alone.";
  }

  const groups = new Map<string, string[]>();
  for (const file of docs) {
    const key = getDocumentationIaGroup(file.path);
    const examples = groups.get(key) ?? [];
    if (examples.length < MAX_DOCUMENTATION_IA_GROUP_EXAMPLES) {
      examples.push(file.path);
    }
    groups.set(key, examples);
  }

  return [...groups.entries()]
    .sort(([aKey], [bKey]) => compareDocumentationPaths(aKey, bKey))
    .slice(0, MAX_DOCUMENTATION_IA_GROUPS)
    .map(([key, examples]) => `- ${key}: ${examples.join(", ")}`)
    .join("\n");
}

function createPublicSurfaceCandidateList(
  files: PreparedRepositoryWorkspace["fileInventory"],
): string {
  const candidates = [...files]
    .filter((file) => isPublicSurfaceCandidate(file.path))
    .sort((a, b) => scorePublicSurfaceCandidate(b.path) - scorePublicSurfaceCandidate(a.path) || a.path.localeCompare(b.path))
    .slice(0, MAX_PUBLIC_SURFACE_CANDIDATES);

  if (candidates.length === 0) {
    return "- No obvious public surface candidates were discovered from paths alone.";
  }

  return candidates.map((file) => `- ${file.path} (${file.language}, ${file.size} bytes)`).join("\n");
}

export function createRepositoryMap(files: PreparedRepositoryWorkspace["fileInventory"]): string {
  if (files.length === 0) return "- No files were discovered.";

  const groups = new Map<
    string,
    {
      bytes: number;
      examples: string[];
      files: number;
      languages: Map<string, number>;
    }
  >();

  for (const file of files) {
    const key = getMapGroupKey(file.path);
    const group = groups.get(key) ?? {
      bytes: 0,
      examples: [],
      files: 0,
      languages: new Map<string, number>(),
    };
    group.bytes += file.size;
    group.files += 1;
    group.languages.set(file.language, (group.languages.get(file.language) ?? 0) + 1);
    if (group.examples.length < MAX_GROUP_EXAMPLES && isRepresentativePath(file.path)) {
      group.examples.push(file.path);
    }
    groups.set(key, group);
  }

  return [...groups.entries()]
    .sort(([aKey, a], [bKey, b]) => {
      const priorityDelta = getGroupPriority(bKey) - getGroupPriority(aKey);
      if (priorityDelta !== 0) return priorityDelta;
      return b.files - a.files;
    })
    .slice(0, MAX_REPOSITORY_MAP_GROUPS)
    .map(([key, group]) => {
      const languages = [...group.languages.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([language, count]) => `${language}:${count}`)
        .join(", ");
      const examples = group.examples.length === 0 ? "" : `; examples: ${group.examples.join(", ")}`;
      return `- ${key}: ${group.files} files, ${formatBytes(group.bytes)}, languages ${languages}${examples}`;
    })
    .join("\n");
}

export function createInventorySample(files: PreparedRepositoryWorkspace["fileInventory"]): string {
  const sampled = [...files]
    .filter((file) => !isInternalPlanningDocumentationPath(file.path))
    .sort((a, b) => scoreInventoryPath(b.path) - scoreInventoryPath(a.path) || a.path.localeCompare(b.path))
    .slice(0, MAX_INVENTORY_SAMPLE_FILES);

  if (sampled.length === 0) return "- No files were discovered.";
  return sampled.map((file) => `- ${file.path} (${file.language}, ${file.size} bytes)`).join("\n");
}

function formatContextSnippets(
  snippets: ContextSnippet[],
  options: {
    maxCharsPerSnippet: number;
    maxSnippets: number;
  },
): string {
  if (snippets.length === 0) return "- No source snippets were available.";
  return snippets
    .slice(0, options.maxSnippets)
    .map((snippet) => `--- ${snippet.path} ---\n${snippet.text.slice(0, options.maxCharsPerSnippet)}`)
    .join("\n\n");
}

function getMapGroupKey(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "root files";
  if (parts[0] === "packages" && parts[1] !== undefined) return `packages/${parts[1]}`;
  if (parts[0] === "apps" && parts[1] !== undefined) return `apps/${parts[1]}`;
  if (parts[0] === "services" && parts[1] !== undefined) return `services/${parts[1]}`;
  if (parts[0] === "crates" && parts[1] !== undefined) return `crates/${parts[1]}`;
  if (parts[0] === "turbopack" && parts[1] === "crates" && parts[2] !== undefined) {
    return `turbopack/crates/${parts[2]}`;
  }
  return parts[0] ?? "root files";
}

function getGroupPriority(key: string): number {
  if (key === "root files") return 1_000;
  if (key === "docs") return 900;
  if (key.startsWith("packages/")) return 850;
  if (key.startsWith("apps/")) return 820;
  if (key.startsWith("crates/")) return 800;
  if (key.startsWith("turbopack/")) return 780;
  if (key === "src") return 760;
  if (key === "test" || key === "tests") return 720;
  if (key === ".github") return 680;
  return 0;
}

function isRepresentativePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    /(^|\/)readme(\.mdx?)?$/.test(normalized) ||
    /(^|\/)package\.json$/.test(normalized) ||
    /(^|\/)cargo\.toml$/.test(normalized) ||
    /(^|\/)(index|main|mod|lib)\.(ts|tsx|js|jsx|rs)$/.test(normalized) ||
    /(^|\/)(next|vite|turbo|jest|vitest|eslint|biome|tsconfig|taskfile)\./.test(normalized)
  );
}

function scoreInventoryPath(path: string): number {
  const normalized = path.toLowerCase();
  let score = 0;
  if (/^readme(\.mdx?)?$/.test(normalized) || normalized === "package.json") score += 2_000;
  if (/^(pnpm-workspace\.yaml|lerna\.json|turbo\.json|cargo\.toml|taskfile\.[jt]s)/.test(normalized)) score += 1_900;
  if (/^packages\/[^/]+\/package\.json$/.test(normalized)) score += 1_600;
  if (/^apps\/[^/]+\/package\.json$/.test(normalized)) score += 1_450;
  if (/^crates\/[^/]+\/cargo\.toml$/.test(normalized)) score += 1_350;
  if (/^turbopack\/crates\/[^/]+\/cargo\.toml$/.test(normalized)) score += 1_300;
  if (/^docs\//.test(normalized)) score += 900;
  if (/^packages\/[^/]+\/src\//.test(normalized)) score += 700;
  if (/^crates\/[^/]+\/src\//.test(normalized)) score += 650;
  if (/^test(s)?\//.test(normalized)) score += 350;
  if (/\.test\.(ts|tsx|js|jsx|rs)$/.test(normalized)) score += 250;
  if (/(^|\/)(node_modules|dist|build|coverage|\.next|compiled|vendor|vendored)(\/|$)/i.test(path)) {
    score -= 2_000;
  }
  return score;
}

function isDocumentationSourceCandidate(path: string): boolean {
  if (isInternalPlanningDocumentationPath(path)) return false;

  const normalized = path.toLowerCase();
  return (
    /^readme(\.mdx?)?$/.test(normalized) ||
    /(^|\/)readme(\.mdx?)?$/.test(normalized) ||
    /(^|\/)(llms\.txt|sitemap\.md|meta\.json|mint\.json|navigation\.(json|ts|tsx|js|jsx))$/.test(normalized) ||
    /^(docs|documentation|content\/docs|site\/docs|website\/docs)\//.test(normalized) ||
    /(^|\/)(docs|documentation|content\/docs|site\/docs|website\/docs)\/.+\.(md|mdx|mdoc|txt|json|yaml|yml)$/.test(normalized)
  );
}

function scoreDocumentationSourceCandidate(path: string): number {
  const normalized = path.toLowerCase();
  let score = 0;

  if (/^readme(\.mdx?)?$/.test(normalized)) score += 2_000;
  if (/^(docs|documentation)\/(llms\.txt|sitemap\.md|meta\.json)$/.test(normalized)) score += 1_900;
  if (/(^|\/)(llms\.txt|sitemap\.md|meta\.json|mint\.json|navigation\.(json|ts|tsx|js|jsx))$/.test(normalized)) {
    score += 1_700;
  }
  if (/(^|\/)(docs|documentation|content\/docs|site\/docs|website\/docs)\/(index|introduction|overview|get-started|getting-started|quickstart)\.(md|mdx|mdoc)$/.test(normalized)) {
    score += 1_550;
  }
  if (/(^|\/)(docs|documentation|content\/docs|site\/docs|website\/docs)\/.+\.(md|mdx|mdoc)$/.test(normalized)) {
    score += 1_200;
  }
  if (/(^|\/)(docs|documentation|content\/docs|site\/docs|website\/docs)\//.test(normalized)) score += 900;
  if (/(^|\/)(api-reference|reference|guides?|tutorials?|concepts?|foundations?|examples?|cookbook|troubleshooting|migration|upgrade)(\/|$)/.test(normalized)) {
    score += 450;
  }
  if (/(^|\/)(test|tests|__tests__|fixtures|__fixtures__|testdata)(\/|$)/.test(normalized)) score -= 600;

  return score;
}

function scoreDocumentationIaPath(path: string): number {
  const normalized = path.toLowerCase();
  let score = scoreDocumentationSourceCandidate(path);

  if (/(^|\/)(docs|documentation|content\/docs|site\/docs|website\/docs)\//.test(normalized)) score += 500;
  if (/(^|\/)(index|introduction|overview|get-started|getting-started|quickstart)\.(md|mdx|mdoc)$/.test(normalized)) {
    score += 350;
  }
  if (/(^|\/)(api-reference|reference|guides?|tutorials?|concepts?|foundations?|examples?|cookbook|troubleshooting|migration|upgrade)(\/|$)/.test(normalized)) {
    score += 250;
  }
  if (/(^|\/)(llms\.txt|sitemap\.md|meta\.json|mint\.json|navigation\.(json|ts|tsx|js|jsx))$/.test(normalized)) {
    score += 600;
  }
  if (/(^|\/)(test|tests|__tests__|fixtures|__fixtures__|testdata)(\/|$)/.test(normalized)) score -= 800;

  return score;
}

function compareDocumentationPaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function getDocumentationIaGroup(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const docsPath = splitDocumentationPath(normalized);
  if (docsPath === undefined) {
    return "root documentation";
  }

  const { root, parts } = docsPath;
  if (parts.length === 0) return root;

  const groupParts = parts
    .slice(0, Math.min(parts.length, 2))
    .map((part) => part.replace(/^\d+[-_.]/, ""));
  const last = groupParts.at(-1);
  if (last !== undefined && /\.(mdx?|mdoc|txt|json|ya?ml)$/i.test(last)) {
    groupParts[groupParts.length - 1] = last.replace(/\.(mdx?|mdoc|txt|json|ya?ml)$/i, "");
  }

  return `${root}/${groupParts.join("/")}`;
}

function splitDocumentationPath(path: string): { parts: string[]; root: string } | undefined {
  const parts = path.split("/").filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());

  const anchoredRoots = [
    ["docs"],
    ["documentation"],
    ["content", "docs"],
    ["site", "docs"],
    ["website", "docs"],
  ];
  for (const rootParts of anchoredRoots) {
    if (rootParts.every((part, index) => lowerParts[index] === part)) {
      return {
        parts: parts.slice(rootParts.length),
        root: parts.slice(0, rootParts.length).join("/"),
      };
    }
  }

  const docsIndex = lowerParts.findIndex((part) => part === "docs" || part === "documentation");
  if (docsIndex < 0) return undefined;

  let rootEnd = docsIndex + 1;
  const next = lowerParts.at(rootEnd);
  const afterNext = lowerParts.at(rootEnd + 1);
  if (next === "content" && afterNext === "docs") {
    rootEnd += 2;
  } else if (next !== undefined && /^(content|pages|src|app)$/.test(next)) {
    rootEnd += 1;
  }

  return {
    parts: parts.slice(rootEnd),
    root: parts.slice(0, rootEnd).join("/"),
  };
}

function isPublicSurfaceCandidate(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    /^readme(\.mdx?)?$/.test(normalized) ||
    /^package\.json$/.test(normalized) ||
    /(^|\/)readme(\.mdx?)?$/.test(normalized) ||
    /(^|\/)package\.json$/.test(normalized) ||
    /(^|\/)(index|main|mod|lib)\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/.test(normalized) ||
    /(^|\/)(cli|command|commands|route|routes|api|client|server|config|options|schema|types)\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/.test(normalized) ||
    /(^|\/)(bin|cli|commands|routes|api|sdk|client|adapters?|plugins?|integrations?)(\/|$)/.test(normalized) ||
    /(^|\/)(docs|content\/docs|site\/docs|website\/docs|examples|cookbook|templates)\//.test(normalized)
  );
}

function scorePublicSurfaceCandidate(path: string): number {
  const normalized = path.toLowerCase();
  let score = 0;

  if (/^readme(\.mdx?)?$/.test(normalized) || normalized === "package.json") score += 2_000;
  if (/^packages\/[^/]+\/readme(\.mdx?)?$/.test(normalized)) score += 1_800;
  if (/^packages\/[^/]+\/package\.json$/.test(normalized)) score += 1_750;
  if (/(^|\/)(index|main|mod|lib)\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/.test(normalized)) score += 1_400;
  if (/(^|\/)(cli|command|commands)\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/.test(normalized)) score += 1_350;
  if (/(^|\/)(route|routes|api|client|server)\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/.test(normalized)) score += 1_250;
  if (/(^|\/)(config|options|schema|types)\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/.test(normalized)) score += 1_100;
  if (/^(docs|content\/docs|site\/docs|website\/docs)\//.test(normalized)) score += 1_000;
  if (/^(examples|cookbook|templates)\//.test(normalized)) score += 800;
  if (/(^|\/)(test|tests|__tests__|fixtures|__fixtures__|testdata)(\/|$)/.test(normalized)) score -= 600;
  if (/(^|\/)(dist|build|coverage|compiled|vendor|vendored)(\/|$)/.test(normalized)) score -= 1_000;

  return score;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
