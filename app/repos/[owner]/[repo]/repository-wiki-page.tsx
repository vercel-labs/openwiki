import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronRight, Clock, ExternalLink } from "lucide-react";
import {
  getRepositoryWiki,
  isArtifactUnavailableError,
  type RepositoryWiki,
  type WikiNavigationNode,
} from "@/lib/storage";
import { formatIndexedAt } from "@/app/lib/format-indexed-at";
import {
  getStorageConfigurationErrorMessage,
  isStorageConfigurationError,
} from "@/app/lib/storage-error";
import { getGitHubOwnerAvatarFallbackUrl, getRepoHref } from "@/lib/github-repo-url";
import { OpenWikiNavbar } from "@/app/components/openwiki-navbar";
import { MobileWikiNav } from "@/app/components/mobile-wiki-nav";
import { PersistentScrollArea } from "@/app/components/persistent-scroll-area";
import { CopyMarkdownButton } from "@/app/components/copy-markdown-button";
import { RepositoryAutoIndex } from "@/app/components/repository-auto-index";
import { RepoChat } from "@/app/components/repo-chat";
import { WikiMarkdown } from "@/app/components/wiki-markdown";

type RepositoryWikiPageProps = {
  owner: string;
  repoName: string;
  slug?: string;
};

export async function RepositoryWikiPage({
  owner,
  repoName,
  slug,
}: RepositoryWikiPageProps) {
  let storedWiki: Awaited<ReturnType<typeof getRepositoryWiki>>;
  try {
    storedWiki = await getRepositoryWiki({ name: repoName, owner, slug });
  } catch (error) {
    if (isStorageConfigurationError(error)) {
      return <StorageConfigurationPage owner={owner} repoName={repoName} />;
    }
    if (isArtifactUnavailableError(error)) {
      return <ArtifactUnavailablePage owner={owner} repoName={repoName} />;
    }
    throw error;
  }

  if (storedWiki === null && slug !== undefined) {
    notFound();
  }

  const wiki = storedWiki ?? createEmptyRepositoryWiki({ owner, repoName });

  if (slug !== undefined && wiki.pages.length > 0 && wiki.currentPage === null) {
    redirect(getRepoHref({ name: repoName, owner }));
  }

  const repoLabel = wiki.repository.fullName;
  const repoUrl = wiki.repository.githubUrl;
  const currentPage = wiki.currentPage;
  const activeSlug = currentPage?.slug ?? "overview";
  const currentPageHref = getWikiPageHref({ owner, repoName, slug: activeSlug });
  const repoRootHref = getRepoHref({ name: repoName, owner });
  const chatHref = `${repoRootHref}/chat`;
  const tableOfContents = currentPage === null ? [] : extractTableOfContents(currentPage.markdown);
  const navbarRepo = {
    activeMode: "wiki" as const,
    chatHref,
    href: currentPageHref,
    iconSrc: getRepositoryIconSrc(wiki.repository.owner, wiki.repository.ownerAvatarUrl),
    label: repoLabel,
    wikiHref: repoRootHref,
  };

  if (currentPage === null && wiki.pages.length === 0) {
    return (
      <main className="h-screen overflow-hidden bg-background text-foreground">
        <OpenWikiNavbar repo={navbarRepo} />
        <section className="mt-10 grid h-[calc(100vh-2.5rem)] place-items-center px-6">
          <RepositoryAutoIndex repoLabel={repoLabel} repoUrl={repoUrl} />
        </section>
      </main>
    );
  }

  return (
    <main className="h-screen overflow-hidden bg-background text-foreground">
      <OpenWikiNavbar
        mobileWikiNav={
          <MobileWikiNav>
            <WikiPageNav
              activeSlug={activeSlug}
              navigation={wiki.navigation}
              owner={wiki.repository.owner}
              pages={wiki.pages}
              repoName={wiki.repository.name}
            />
          </MobileWikiNav>
        }
        repo={navbarRepo}
      />

      <div className="mx-auto mt-10 grid h-[calc(100vh-2.5rem)] w-full grid-cols-1 gap-10 overflow-y-auto px-6 py-10 lg:w-[min(1440px,calc(100vw-48px))] lg:grid-cols-[300px_minmax(0,760px)_240px] lg:overflow-hidden lg:px-0 lg:py-0">
        <PersistentScrollArea
          ariaLabel="Wiki pages"
          className="hidden self-start text-sm text-muted-foreground lg:block lg:h-full lg:overflow-y-auto lg:py-10 lg:pr-2"
          storageKey={`openwiki:wiki-nav-scroll:${wiki.repository.owner}/${wiki.repository.name}`}
        >
          <WikiPageNav
            activeSlug={activeSlug}
            navigation={wiki.navigation}
            owner={wiki.repository.owner}
            pages={wiki.pages}
            repoName={wiki.repository.name}
          />
        </PersistentScrollArea>

        <article className="min-w-0 pb-28 lg:h-full lg:overflow-y-auto lg:pt-10 lg:pb-32">
          {currentPage === null ? (
            <RepositoryAutoIndex repoLabel={repoLabel} repoUrl={repoUrl} />
          ) : (
            <section>
              <WikiMarkdown
                commitSha={wiki.commitSha}
                markdown={currentPage.markdown}
                owner={wiki.repository.owner}
                repoName={wiki.repository.name}
              />
            </section>
          )}

          <RepoChat chatHref={chatHref} repoLabel={repoLabel} />
        </article>

        <aside
          className="self-start text-sm text-muted-foreground lg:h-full lg:overflow-y-auto lg:py-10 lg:pl-2"
          aria-label="On this page"
        >
          <div className="mb-6 grid gap-0 text-sm">
            <a
              className="flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 leading-[18px] text-muted-foreground transition-colors hover:text-foreground"
              href={repoUrl}
              rel="noreferrer"
              target="_blank"
              title={repoUrl}
            >
              <GitHubMark className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono">{repoLabel}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
            <p className="flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 leading-[18px] tabular-nums">
              <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {wiki.indexedAt === null
                  ? "not yet"
                  : formatIndexedAt(wiki.indexedAt, Date.now())}
              </span>
            </p>
          </div>
          <PageTableOfContents items={tableOfContents} />
          {currentPage === null ? null : (
            <CopyMarkdownButton markdown={currentPage.markdown} />
          )}
        </aside>
      </div>
    </main>
  );
}

function ArtifactUnavailablePage({
  owner,
  repoName,
}: {
  owner: string;
  repoName: string;
}) {
  const repoLabel = `${owner}/${repoName}`;
  const repoUrl = `https://github.com/${owner}/${repoName}`;
  const isLocalRuntime = process.env.NODE_ENV !== "production" || process.env.VERCEL_REGION === undefined;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <OpenWikiNavbar
        repo={{
          activeMode: "wiki",
          chatHref: `${getRepoHref({ name: repoName, owner })}/chat`,
          href: getRepoHref({ name: repoName, owner }),
          iconSrc: getRepositoryIconSrc(owner, null),
          label: repoLabel,
          wikiHref: getRepoHref({ name: repoName, owner }),
        }}
      />
      <section className="mx-auto grid min-h-[calc(100vh-2.5rem)] w-[min(760px,calc(100vw-32px))] place-content-center justify-items-center gap-5 px-4 py-16 text-center">
        <div className="grid max-w-2xl justify-items-center gap-3">
          <h1 className="m-0 text-3xl font-semibold tracking-normal">
            {isLocalRuntime ? "Configure Blob access locally." : "Republish this wiki."}
          </h1>
          <p className="m-0 max-w-xl text-sm leading-6 text-muted-foreground">
            {isLocalRuntime
              ? "The current wiki revision points at private Blob artifacts. Set a local BLOB_READ_WRITE_TOKEN to read this content here, or verify the deployed app where Blob OIDC is available."
              : "The current wiki revision points at artifacts that are not available in this runtime. A fresh publish is needed before this wiki can be viewed here."}
          </p>
        </div>
        {isLocalRuntime ? (
          <div className="grid w-fit gap-2 rounded-md border bg-card px-4 py-3 font-mono text-sm text-muted-foreground">
            <span>BLOB_READ_WRITE_TOKEN=...</span>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function StorageConfigurationPage({
  owner,
  repoName,
}: {
  owner: string;
  repoName: string;
}) {
  const repoLabel = `${owner}/${repoName}`;
  const repoUrl = `https://github.com/${owner}/${repoName}`;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <OpenWikiNavbar
        repo={{
          activeMode: "wiki",
          chatHref: `${getRepoHref({ name: repoName, owner })}/chat`,
          href: getRepoHref({ name: repoName, owner }),
          iconSrc: getRepositoryIconSrc(owner, null),
          label: repoLabel,
          wikiHref: getRepoHref({ name: repoName, owner }),
        }}
      />
      <section className="mx-auto grid min-h-[calc(100vh-2.5rem)] w-[min(760px,calc(100vw-32px))] content-center gap-5 py-16">
        <div className="grid gap-3">
          <p className="m-0 text-sm font-medium text-muted-foreground">Storage setup required</p>
          <h1 className="m-0 text-3xl font-semibold tracking-normal">OpenWiki can reach the repo route.</h1>
          <p className="m-0 text-base leading-7 text-muted-foreground">
            {getStorageConfigurationErrorMessage()}
          </p>
        </div>
        <div className="grid gap-2 rounded-md border bg-card p-4 font-mono text-sm">
          <span>DATABASE_URL=postgres://...</span>
          <span>BLOB_READ_WRITE_TOKEN=...</span>
          <span>GITHUB_TOKEN=... # optional public repo rate limits</span>
        </div>
        <a
          className="inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
          href={repoUrl}
          rel="noreferrer"
          target="_blank"
        >
          Open repository
          <ExternalLink className="h-4 w-4" />
        </a>
      </section>
    </main>
  );
}

function createEmptyRepositoryWiki({
  owner,
  repoName,
}: {
  owner: string;
  repoName: string;
}): RepositoryWiki {
  return {
    commitSha: null,
    currentPage: null,
    generatorVersion: null,
    indexedAt: null,
    navigation: [],
    pages: [],
    repository: {
      currentIndexedRevisionId: null,
      fullName: `${owner}/${repoName}`,
      githubUrl: `https://github.com/${owner}/${repoName}`,
      id: "",
      name: repoName,
      owner,
      ownerAvatarUrl: null,
      updatedAt: "",
    },
  };
}

function WikiPageNav({
  activeSlug,
  navigation,
  owner,
  pages,
  repoName,
}: {
  activeSlug: string;
  navigation: WikiNavigationNode[];
  owner: string;
  pages: Array<{ id: string; slug: string; title: string }>;
  repoName: string;
}) {
  const navItems =
    navigation.length > 0
      ? navigation
      : pages.map((page) => ({
          children: [],
          slug: page.slug,
          title: page.title,
        }));

  return (
    <nav className="grid gap-0 text-[14px] text-muted-foreground">
      {navItems.map((node, index) => (
        <div className={index === 0 ? "" : "pt-1"} key={`${node.slug ?? "section"}-${index}`}>
          <WikiNavNode
            activeSlug={activeSlug}
            node={node}
            owner={owner}
            repoName={repoName}
          />
        </div>
      ))}
      {pages.length === 0 ? <p className="px-2 text-sm">No wiki pages generated yet.</p> : null}
    </nav>
  );
}

function WikiNavNode({
  activeSlug,
  node,
  owner,
  repoName,
}: {
  activeSlug: string;
  node: WikiNavigationNode;
  owner: string;
  repoName: string;
}) {
  const isActive = node.slug === activeSlug;
  const hasChildren = node.children.length > 0;
  const rowClassName = `flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-[6.5px] leading-[18px] transition-colors hover:text-foreground ${
    isActive ? "bg-muted font-medium text-foreground" : ""
  }`;

  return (
    <div className="grid gap-0">
      {hasChildren ? (
        <details className="group grid gap-0" open>
          <summary className="flex min-h-8 min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-2 py-[6.5px] leading-[18px] transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1 truncate">{node.title}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-100 group-open:rotate-90" />
          </summary>
          <div className="relative ml-4 grid gap-0 pl-3 before:absolute before:top-2 before:bottom-2 before:left-0 before:w-px before:bg-border before:content-['']">
            {node.children.map((child, index) => (
              <WikiNavNode
                activeSlug={activeSlug}
                key={`${child.slug ?? "section"}-${index}`}
                node={child}
                owner={owner}
                repoName={repoName}
              />
            ))}
          </div>
        </details>
      ) : node.slug === undefined ? (
        <div className={rowClassName}>
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
        </div>
      ) : (
        <Link
          aria-current={isActive ? "page" : undefined}
          className={rowClassName}
          href={getWikiPageHref({ owner, repoName, slug: node.slug })}
        >
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
        </Link>
      )}
    </div>
  );
}

function PageTableOfContents({ items }: { items: TableOfContentsItem[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <nav aria-label="On this page" className="grid gap-0 border-t pt-5 text-sm">
      {items.map((item) => (
        <a
          className="flex min-h-8 items-center rounded-md py-1.5 pr-3 leading-[18px] transition-colors hover:text-foreground"
          href={`#${item.id}`}
          key={item.id}
          style={{ paddingLeft: `${8 + Math.max(0, item.depth - 2) * 12}px` }}
        >
          {item.title}
        </a>
      ))}
    </nav>
  );
}

type TableOfContentsItem = {
  depth: number;
  id: string;
  title: string;
};

function extractTableOfContents(markdown: string): TableOfContentsItem[] {
  const seen = new Map<string, number>();
  return markdown
    .split("\n")
    .flatMap((line) => {
      const match = /^(#{2,3})\s+(.+)$/.exec(line.trim());
      if (match === null) return [];
      const title = stripMarkdown(match[2] ?? "").trim();
      if (title.length === 0) return [];
      const baseId = slugifyHeading(title);
      const count = seen.get(baseId) ?? 0;
      seen.set(baseId, count + 1);
      return [
        {
          depth: match[1]?.length ?? 2,
          id: count === 0 ? baseId : `${baseId}-${count + 1}`,
          title,
        },
      ];
    })
    .slice(0, 24);
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]/g, "");
}

function slugifyHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getWikiPageHref(input: {
  owner: string;
  repoName: string;
  slug: string;
}): string {
  const repoHref = getRepoHref({ name: input.repoName, owner: input.owner });
  return input.slug === "overview" ? repoHref : `${repoHref}/${input.slug}`;
}

function getRepositoryIconSrc(owner: string, ownerAvatarUrl: string | null): string {
  return ownerAvatarUrl ?? getGitHubOwnerAvatarFallbackUrl(owner);
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.66.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.32 9.32 0 0 1 12 6.97c.85 0 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.95.68 1.92v2.79c0 .27.18.59.69.49A10.17 10.17 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
