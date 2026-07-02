import type { CitationInput, WikiPageInput } from "@/lib/storage";
import { z } from "zod";
import { MAX_WIKI_PAGES } from "./types.js";

const optionalPositiveLineNumberSchema = z.preprocess(
  (value) => (typeof value === "number" && value > 0 ? value : undefined),
  z.number().int().positive().optional(),
);

const nullablePositiveLineNumberSchema = z.preprocess(
  (value) => (typeof value === "number" && value > 0 ? value : null),
  z.number().int().positive().nullable(),
);

const citationSchema = z.object({
  endLine: optionalPositiveLineNumberSchema,
  path: z.string().min(1),
  startLine: optionalPositiveLineNumberSchema,
});

const pageDraftSchema = z
  .object({
    citations: z.array(citationSchema).default([]),
    coverageNotes: z.array(z.string()).default([]),
    markdown: z.string().optional(),
    markdownLines: z.array(z.string()).optional(),
    relatedPages: z.array(z.string()).default([]),
    slug: z.string().min(1),
    title: z.string().min(1),
  })
  .transform((page, ctx) => {
    const markdown = page.markdown ?? page.markdownLines?.join("\n");
    if (markdown === undefined || markdown.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Expected page markdown or markdownLines.",
        path: ["markdown"],
      });
      return z.NEVER;
    }

    return {
      citations: page.citations,
      coverageNotes: page.coverageNotes,
      markdown,
      relatedPages: page.relatedPages,
      slug: page.slug,
      title: page.title,
    };
  });

const generationCitationSchema = z.object({
  endLine: nullablePositiveLineNumberSchema,
  path: z.string().min(1),
  startLine: nullablePositiveLineNumberSchema,
});

const pageGenerationDraftSchema = z.object({
  citations: z.array(generationCitationSchema),
  coverageNotes: z.array(z.string()),
  markdownLines: z.array(z.string()).min(1),
  relatedPages: z.array(z.string()),
  slug: z.string().min(1),
  title: z.string().min(1),
});

export const pageGenerationSchema = z.object({
  pages: z.array(pageGenerationDraftSchema).min(1),
});

const pageDraftsSchema = z.preprocess((value) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "pages" in value &&
    Array.isArray((value as { pages?: unknown }).pages)
  ) {
    return (value as { pages: unknown[] }).pages;
  }

  return value;
}, z.array(pageDraftSchema).min(1));

type NavigationNode = {
  children?: NavigationNode[];
  slug?: string;
  title: string;
};

const navigationNodeSchema: z.ZodType<NavigationNode> = z.object({
  children: z.array(z.lazy(() => navigationNodeSchema)).optional(),
  slug: z.string().optional(),
  title: z.string().min(1),
});

const pagePrioritySchema = z.preprocess((value) => {
  if (value === "required" || value === "recommended" || value === "optional") {
    return value;
  }
  return "recommended";
}, z.enum(["required", "recommended", "optional"]));

export const outlineSchema = z.object({
  concepts: z
    .array(
      z.object({
        description: z.string(),
        name: z.string(),
        sourcePaths: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  navigation: z.array(navigationNodeSchema).default([]),
  pages: z
    .array(
      z.object({
        priority: pagePrioritySchema.default("recommended"),
        purpose: z.string(),
        slug: z.string(),
        sourcePaths: z.array(z.string()).default([]),
        title: z.string(),
      }),
    )
    .min(1),
  summary: z.string().min(1),
  title: z.string().min(1),
});

type GeneratedNavigationNode = {
  children?: GeneratedNavigationNode[];
  slug?: string | null;
  title: string;
};

const outlineGenerationNavigationLeafSchema = z.object({
  slug: z.string().nullable(),
  title: z.string().min(1),
});

const outlineGenerationNavigationLevel3Schema = z.object({
  children: z.array(outlineGenerationNavigationLeafSchema),
  slug: z.string().nullable(),
  title: z.string().min(1),
});

const outlineGenerationNavigationLevel2Schema = z.object({
  children: z.array(outlineGenerationNavigationLevel3Schema),
  slug: z.string().nullable(),
  title: z.string().min(1),
});

const outlineGenerationNavigationNodeSchema: z.ZodType<GeneratedNavigationNode> = z.object({
  children: z.array(outlineGenerationNavigationLevel2Schema),
  slug: z.string().nullable(),
  title: z.string().min(1),
});

export const outlineGenerationSchema = z.object({
  concepts: z.array(
    z.object({
      description: z.string(),
      name: z.string(),
      sourcePaths: z.array(z.string()),
    }),
  ),
  navigation: z.array(outlineGenerationNavigationNodeSchema),
  pages: z.array(
    z.object({
      priority: z.enum(["required", "recommended", "optional"]),
      purpose: z.string(),
      slug: z.string(),
      sourcePaths: z.array(z.string()),
      title: z.string(),
    }),
  ).min(1),
  summary: z.string().min(1),
  title: z.string().min(1),
});

const indexOutputSchema = z.object({
  outline: outlineSchema,
  pages: pageDraftsSchema,
  repositorySummary: z.string().min(1),
});

export type ParsedIndexOutput = z.infer<typeof indexOutputSchema>;
export type ParsedOutline = z.infer<typeof outlineSchema>;
export type ParsedOutlinePage = ParsedOutline["pages"][number];
export type ParsedPageDraft = z.infer<typeof pageDraftSchema>;

type GeneratedOutline = z.infer<typeof outlineGenerationSchema>;
type GeneratedPageGeneration = z.infer<typeof pageGenerationSchema>;

export function normalizeOutlineNavigation(outline: ParsedOutline): ParsedOutline {
  return {
    ...outline,
    navigation: collapseSinglePageNavigationFolders(outline.navigation),
  };
}

export function parseIndexOutput(value: string): ParsedIndexOutput {
  const output = indexOutputSchema.parse(parseJsonObject(value));
  return {
    ...output,
    outline: normalizeOutlineNavigation(output.outline),
  };
}

export function parseOutlineOutput(value: string): ParsedOutline {
  return outlineSchema.parse(parseJsonObject(value));
}

export function parsePageDraftsOutput(value: string): ParsedPageDraft[] {
  return pageDraftsSchema.parse(parseJsonObject(value));
}

export function normalizeGeneratedOutline(outline: GeneratedOutline): ParsedOutline {
  return outlineSchema.parse({
    ...outline,
    navigation: normalizeGeneratedNavigationNodes(outline.navigation),
  });
}

export function normalizeGeneratedPageDrafts(output: GeneratedPageGeneration): ParsedPageDraft[] {
  return pageDraftsSchema.parse(output);
}

export function normalizePages(
  pages: z.infer<typeof pageDraftSchema>[],
  validPaths: Set<string>,
): WikiPageInput[] {
  const seenSlugs = new Set<string>();
  const normalized: WikiPageInput[] = [];

  for (const page of pages.slice(0, MAX_WIKI_PAGES)) {
    const slug = normalizeSlug(page.slug);
    if (slug.length === 0 || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    normalized.push({
      citations: normalizeCitations(page.citations, validPaths),
      markdown: page.markdown,
      slug,
      title: page.title,
    });
  }

  return normalized;
}

function normalizeCitations(citations: CitationInput[], validPaths: Set<string>): CitationInput[] {
  return citations
    .filter((citation) => validPaths.has(citation.path))
    .map((citation) => {
      const normalized: CitationInput = { path: citation.path };
      if (citation.startLine !== undefined) normalized.startLine = citation.startLine;
      if (citation.endLine !== undefined) normalized.endLine = citation.endLine;
      return normalized;
    });
}

function normalizeGeneratedNavigationNodes(nodes: GeneratedNavigationNode[]): NavigationNode[] {
  return nodes.map((node) => ({
    children: normalizeGeneratedNavigationNodes(node.children ?? []),
    ...(node.slug === null || node.slug === undefined ? {} : { slug: node.slug }),
    title: node.title,
  }));
}

function collapseSinglePageNavigationFolders(nodes: NavigationNode[]): NavigationNode[] {
  return nodes.flatMap((node) => {
    const children = collapseSinglePageNavigationFolders(node.children ?? []);
    const normalized: NavigationNode = {
      title: node.title,
      ...(node.slug === undefined ? {} : { slug: node.slug }),
      ...(children.length === 0 ? {} : { children }),
    };

    if (normalized.slug === undefined && children.length === 1) {
      const [child] = children;
      if (child !== undefined && child.slug !== undefined && (child.children?.length ?? 0) === 0) {
        return [child];
      }
    }

    return [normalized];
  });
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseJsonObject(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    return JSON.parse(fenced[1].trim());
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  throw new Error("Indexing run did not return JSON.");
}
