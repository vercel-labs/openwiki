import { MAX_WIKI_PAGES } from "./types.js";

const MAX_RUNTIME_WIKI_PAGES = 52;

export type WikiQualityEvidence = {
  documentationSourceCount: number;
  fileCount: number;
  officialDocsLinkCount?: number;
};

export type WikiPageQualityTarget = {
  purpose?: string;
  slug: string;
  sourcePaths?: readonly string[];
  title: string;
};

export function getMaxOutlinePagesForEvidence(input: WikiQualityEvidence): number {
  const baseline = input.fileCount < 25
    ? 4
    : input.fileCount < 50
      ? 5
      : input.fileCount < 500
        ? 12
        : input.fileCount < 2_000
          ? 24
          : 36;

  let docsTarget = baseline;
  if ((input.officialDocsLinkCount ?? 0) >= 700) docsTarget = 100;
  else if ((input.officialDocsLinkCount ?? 0) >= 450) docsTarget = 90;
  else if ((input.officialDocsLinkCount ?? 0) >= 260) docsTarget = 80;
  else if ((input.officialDocsLinkCount ?? 0) >= 160) docsTarget = 72;
  else if ((input.officialDocsLinkCount ?? 0) >= 90) docsTarget = 60;
  else if ((input.officialDocsLinkCount ?? 0) >= 60) docsTarget = 48;
  else if ((input.officialDocsLinkCount ?? 0) >= 30) docsTarget = 28;
  else if (input.documentationSourceCount >= 700) docsTarget = 100;
  else if (input.documentationSourceCount >= 450) docsTarget = 90;
  else if (input.documentationSourceCount >= 300) docsTarget = 80;
  else if (input.documentationSourceCount >= 180) docsTarget = 72;
  else if (input.documentationSourceCount >= 100) docsTarget = 60;
  else if (input.documentationSourceCount >= 60) docsTarget = 48;
  else if (input.documentationSourceCount >= 30) docsTarget = 28;
  else if (input.documentationSourceCount >= 12) docsTarget = 14;

  return Math.min(MAX_WIKI_PAGES, MAX_RUNTIME_WIKI_PAGES, Math.max(baseline, docsTarget));
}

export function getMinOutlinePagesForEvidence(input: WikiQualityEvidence): number {
  const baseline = input.fileCount < 25
    ? 3
    : input.fileCount < 50
      ? 3
      : input.fileCount < 500
        ? 6
        : input.fileCount < 2_000
          ? 14
          : 18;
  const maxPages = getMaxOutlinePagesForEvidence(input);

  let docsTarget = baseline;
  if ((input.officialDocsLinkCount ?? 0) >= 700) docsTarget = 80;
  else if ((input.officialDocsLinkCount ?? 0) >= 450) docsTarget = 72;
  else if ((input.officialDocsLinkCount ?? 0) >= 260) docsTarget = 64;
  else if ((input.officialDocsLinkCount ?? 0) >= 160) docsTarget = 56;
  else if ((input.officialDocsLinkCount ?? 0) >= 90) docsTarget = 48;
  else if ((input.officialDocsLinkCount ?? 0) >= 60) docsTarget = 38;
  else if ((input.officialDocsLinkCount ?? 0) >= 30) docsTarget = 20;
  else if (input.documentationSourceCount >= 700) docsTarget = 80;
  else if (input.documentationSourceCount >= 450) docsTarget = 72;
  else if (input.documentationSourceCount >= 300) docsTarget = 64;
  else if (input.documentationSourceCount >= 180) docsTarget = 56;
  else if (input.documentationSourceCount >= 100) docsTarget = 48;
  else if (input.documentationSourceCount >= 60) docsTarget = 36;
  else if (input.documentationSourceCount >= 30) docsTarget = 20;
  else if (input.documentationSourceCount >= 12) docsTarget = 10;

  return Math.min(maxPages, Math.max(baseline, docsTarget));
}

export function getMinPageWordsForEvidence(input: WikiQualityEvidence): number {
  const baseline = input.fileCount < 25
    ? 450
    : input.fileCount < 50
      ? 500
      : input.fileCount < 500
        ? 575
        : 650;

  if ((input.officialDocsLinkCount ?? 0) >= 120) return Math.max(baseline, 1_050);
  if ((input.officialDocsLinkCount ?? 0) >= 60) return Math.max(baseline, 1_000);
  if (input.documentationSourceCount >= 100) return Math.max(baseline, 1_000);
  if (input.documentationSourceCount >= 60) return Math.max(baseline, 850);
  if (input.documentationSourceCount >= 30) return Math.max(baseline, 750);
  if (input.documentationSourceCount >= 12) return Math.max(baseline, 700);
  return baseline;
}

export function getMinPageWordsForTarget(
  input: WikiQualityEvidence & { page: WikiPageQualityTarget },
): number {
  const baseline = input.fileCount < 25
    ? 450
    : input.fileCount < 50
      ? 500
      : input.fileCount < 500
        ? 575
        : 650;
  const tinyLeaf = isTinyLeafPage(input.page);
  const agentPrimitiveLeaf = isAgentPrimitiveLeafPage(input.page);
  const essentialReaderJourneyPage = isEssentialReaderJourneyPage(input.page);
  const focusedApiLeaf = isFocusedApiLeafPage(input.page);
  const specializedImplementationLeaf = isSpecializedImplementationLeafPage(input.page);
  const breadth = getPageTargetBreadth(input.page);
  const leafBaseline = Math.min(baseline, 500);
  const narrowBaseline = Math.min(baseline, 575);
  const normalBaseline = Math.min(baseline, 650);

  if ((input.officialDocsLinkCount ?? 0) >= 120) {
    if (tinyLeaf) return Math.max(leafBaseline, 450);
    if (essentialReaderJourneyPage) return Math.max(narrowBaseline, 600);
    if (agentPrimitiveLeaf) return Math.max(leafBaseline, 500);
    if (focusedApiLeaf) return Math.max(leafBaseline, 550);
    if (specializedImplementationLeaf) return Math.max(leafBaseline, 550);
    if (breadth === "broad") return Math.max(baseline, 800);
    if (breadth === "narrow") return Math.max(narrowBaseline, 575);
    return Math.max(normalBaseline, 700);
  }
  if ((input.officialDocsLinkCount ?? 0) >= 60) {
    if (tinyLeaf) return Math.max(leafBaseline, 450);
    if (essentialReaderJourneyPage) return Math.max(narrowBaseline, 575);
    if (agentPrimitiveLeaf) return Math.max(leafBaseline, 500);
    if (focusedApiLeaf) return Math.max(leafBaseline, 525);
    if (specializedImplementationLeaf) return Math.max(leafBaseline, 525);
    if (breadth === "broad") return Math.max(baseline, 775);
    if (breadth === "narrow") return Math.max(narrowBaseline, 550);
    return Math.max(normalBaseline, 675);
  }
  if (input.documentationSourceCount >= 100) {
    if (tinyLeaf) return Math.max(leafBaseline, 450);
    if (essentialReaderJourneyPage) return Math.max(narrowBaseline, 575);
    if (agentPrimitiveLeaf) return Math.max(leafBaseline, 500);
    if (focusedApiLeaf) return Math.max(leafBaseline, 550);
    if (specializedImplementationLeaf) return Math.max(leafBaseline, 550);
    if (breadth === "broad") return Math.max(baseline, 775);
    if (breadth === "narrow") return Math.max(narrowBaseline, 550);
    return Math.max(normalBaseline, 675);
  }
  if (input.documentationSourceCount >= 60) {
    if (tinyLeaf) return Math.max(leafBaseline, 450);
    if (essentialReaderJourneyPage) return Math.max(narrowBaseline, 550);
    if (agentPrimitiveLeaf) return Math.max(leafBaseline, 500);
    if (focusedApiLeaf) return Math.max(leafBaseline, 525);
    if (specializedImplementationLeaf) return Math.max(leafBaseline, 525);
    if (breadth === "broad") return Math.max(baseline, 750);
    if (breadth === "narrow") return Math.max(narrowBaseline, 525);
    return Math.max(normalBaseline, 650);
  }
  if (input.documentationSourceCount >= 30) {
    if (tinyLeaf) return Math.max(baseline, 575);
    if (breadth === "broad") return Math.max(baseline, 800);
    if (breadth === "narrow") return Math.max(baseline, 700);
    return Math.max(baseline, 750);
  }
  if (input.documentationSourceCount >= 12) {
    if (breadth === "narrow") return Math.max(baseline, 650);
    return Math.max(baseline, 700);
  }
  return baseline;
}

function getPageTargetBreadth(page: WikiPageQualityTarget): "broad" | "normal" | "narrow" {
  const text = `${page.slug} ${page.title} ${page.purpose ?? ""}`.toLowerCase();
  const slug = page.slug.toLowerCase();
  const sourceCount = page.sourcePaths?.length;

  if (
    /^reference-api-v\d+(?:-[a-z0-9]+){2,}$/.test(slug) ||
    /^(?:react|react-dom|eslint-plugin-react-hooks|legacy-apis|rules-of-react|react-compiler)-(?:components?|hooks?|apis?|client-apis|server-apis|static-apis|directives|configuration|lints?)$/.test(slug) ||
    /^(?:react|react-dom|eslint-plugin-react-hooks|legacy-apis|rules-of-react|react-compiler)-(?:components?|hooks?|apis?|client-apis|server-apis|static-apis|directives|configuration|lints?)-[a-z0-9]/.test(slug) ||
    /\b(examples?|cookbook|recipe|quickstart|starter|template|troubleshoot|troubleshooting|migration|upgrade|integration|adapter|provider|model|embedding|vector|search|client|sdk|framework|library|astrojs|nextjs|nuxt|sveltekit|flutter|swift|kotlin|python|javascript|typescript|beeke?eper|studio)\b/.test(text)
  ) {
    return "narrow";
  }

  if (
    slug === "overview" ||
    slug.endsWith("-overview") ||
    /\b(architecture|concepts?|reference|api reference|getting started|installation|configuration|security|auth|authentication|database|storage|realtime|routing|rendering|compiler|server components?)\b/.test(text)
  ) {
    return "broad";
  }

  if (slug.startsWith("guides-")) {
    return "narrow";
  }

  if (sourceCount !== undefined && sourceCount <= 2) {
    return "narrow";
  }

  return "normal";
}

function isTinyLeafPage(page: WikiPageQualityTarget): boolean {
  const sourceCount = page.sourcePaths?.length;
  if (sourceCount === undefined || sourceCount > 2) return false;
  return !isBroadPageTopic(page);
}

function isSpecializedImplementationLeafPage(page: WikiPageQualityTarget): boolean {
  if (isBroadPageTopic(page)) return false;
  const text = `${page.slug} ${page.title} ${page.purpose ?? ""}`.toLowerCase();
  return /\b(custom[- ]renderers?|reconciler|host[- ]config|repository[- ]development|devtools[- ]core|inline[- ]devtools|native[- ]style[- ]editor)\b/.test(
    text,
  );
}

function isFocusedApiLeafPage(page: WikiPageQualityTarget): boolean {
  const text = `${page.slug} ${page.title} ${page.purpose ?? ""}`.toLowerCase();
  const slug = page.slug.toLowerCase();
  return /^react-(?:act|cache|create-context|fragment|lazy|memo|profiler|start-transition|strict-mode|suspense|use)$/.test(slug) ||
    /\b(streaming[- ]rendering|server[- ]streaming|resume[- ]and[- ]prerender|react[- ]dom[- ]server[- ]apis?|react[- ]dom[- ]static[- ]apis?)\b/.test(
    text,
  );
}

function isAgentPrimitiveLeafPage(page: WikiPageQualityTarget): boolean {
  if (isBroadPageTopic(page)) return false;
  const text = `${page.slug} ${page.title} ${page.purpose ?? ""}`.toLowerCase();
  return /\b(instructions?|skills?|channels?|connections?|mcp|openapi|open api|sandbox|subagents?|schedules?|evals?|sessions?|streaming|continuations?|client|sdk|hooks?|approvals?)\b/.test(
    text,
  );
}

function isEssentialReaderJourneyPage(page: WikiPageQualityTarget): boolean {
  const text = `${page.slug} ${page.title} ${page.purpose ?? ""}`.toLowerCase();
  return /\b(getting[- ]started|quick[- ]?start|first[- ]agent|tutorial|installation|setup|workflow)\b/.test(text);
}

function isBroadPageTopic(page: WikiPageQualityTarget): boolean {
  const text = `${page.slug} ${page.title} ${page.purpose ?? ""}`.toLowerCase();
  const slug = page.slug.toLowerCase();
  return (
    slug === "overview" ||
    slug.endsWith("-overview") ||
    /\b(architecture|concepts?|reference|api reference|getting started|installation|configuration|security|auth|authentication|database|storage|realtime|routing|rendering|compiler|server components?)\b/.test(text)
  );
}
