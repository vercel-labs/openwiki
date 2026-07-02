"use client";

import type { ClipboardEvent, ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getGitHubOwnerAvatarFallbackUrl, getRepoHref, parseGitHubRepoUrl } from "@/lib/github-repo-url";
import type { FeaturedRepositoryCard } from "@/app/lib/featured-repositories";
import { ArrowRight, Plus, Star } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { OpenWikiHeroLogo } from "./openwiki-hero-logo";
import { OpenWikiNavbar } from "./openwiki-navbar";

const openWikiGitHubUrl = "https://github.com/vercel-labs/openwiki";

type FormSubmitEvent = Parameters<NonNullable<ComponentProps<"form">["onSubmit"]>>[0];

type RepositorySearchResult = {
  description: string | null;
  fullName: string;
  iconSrc: string | null;
  repoUrl: string;
  starCount: number | null;
};

type FeaturedRepositoryResult = RepositorySearchResult & {
  description: string;
  starLabel?: string;
};

export function RepositoryHome({
  initialFeaturedRepositories,
}: {
  initialFeaturedRepositories: FeaturedRepositoryCard[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [repoUrl, setRepoUrl] = useState("");
  const [repoUrlError, setRepoUrlError] = useState<string | null>(null);
  const [featuredRepoCards, setFeaturedRepoCards] = useState(initialFeaturedRepositories);
  const [searchResults, setSearchResults] = useState<RepositorySearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  const trimmedRepoUrl = repoUrl.trim();
  const isSearching = trimmedRepoUrl.length >= 2 && parseGitHubRepoUrl(trimmedRepoUrl) === null;
  const isSearchLoading = isSearching && searchStatus === "loading";
  let searchStatusMessage: string | null = null;
  if (isSearching && searchStatus === "success" && searchResults.length === 0) {
    searchStatusMessage = "No GitHub repositories found.";
  } else if (isSearching && searchStatus === "error") {
    searchStatusMessage = "Could not search GitHub repositories.";
  }

  useEffect(() => {
    setRepoUrl(searchParams.get("q") ?? "");
  }, [searchParams]);

  useEffect(() => {
    const controller = new AbortController();

    async function refreshFeaturedMetadata() {
      try {
        const response = await fetch("/api/repositories/featured", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          repositories?: FeaturedRepositoryResult[];
        };

        if (!response.ok || payload.repositories === undefined) {
          return;
        }

        setFeaturedRepoCards(payload.repositories);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }

    void refreshFeaturedMetadata();

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const query = repoUrl.trim();
    if (query.length < 2 || parseGitHubRepoUrl(query) !== null) {
      setSearchResults([]);
      setSearchStatus("idle");
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setSearchStatus("loading");
      setSearchResults([]);
      try {
        const response = await fetch(`/api/repositories/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          error?: string;
          repositories?: RepositorySearchResult[];
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "Could not search GitHub repositories.");
        }

        setSearchResults(payload.repositories ?? []);
        setSearchStatus("success");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSearchResults([]);
        setSearchStatus("error");
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [repoUrl]);

  async function onAddRepoSubmit(event: FormSubmitEvent) {
    event.preventDefault();
    navigateToRepository(repoUrl);
  }

  function navigateToRepository(nextRepoUrl: string) {
    const parsed = parseGitHubRepoUrl(nextRepoUrl);

    if (parsed === null) {
      setRepoUrlError("Enter a public GitHub repository URL.");
      return;
    }

    router.push(getRepoHref(parsed));
  }

  function onRepoUrlChange(nextRepoUrl: string) {
    setRepoUrl(nextRepoUrl);
    setRepoUrlError(null);
    updateSearchQueryParam(nextRepoUrl);
  }

  function onRepoUrlPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pastedText = event.clipboardData.getData("text").trim();
    if (parseGitHubRepoUrl(pastedText) === null) {
      return;
    }

    event.preventDefault();
    setRepoUrl(pastedText);
    setRepoUrlError(null);
    updateSearchQueryParam(pastedText);
    navigateToRepository(pastedText);
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <OpenWikiNavbar showRepositoryLinkLabelOnMobile />

      <section className="mx-auto grid w-[min(960px,calc(100vw-32px))] gap-10 pt-16 pb-16 md:pt-24">
        <div className="grid gap-4">
          <OpenWikiHeroLogo />

          <p className="m-0 max-w-[560px] text-pretty text-[16px] leading-7 text-muted-foreground md:max-w-[760px]">
            Generate a living, source-grounded wiki for any GitHub repository.{" "}
            <span className="whitespace-nowrap">
              Built on{" "}
              <Link
                className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
                href="https://eve.dev"
              >
                eve
              </Link>
              .
            </span>
          </p>

          <form className="grid max-w-[480px] gap-2" onSubmit={onAddRepoSubmit}>
            <div className="relative">
              <GitHubMark className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-foreground/80" />
              <Input
                aria-describedby={repoUrlError ? "repo-url-error" : undefined}
                aria-label="GitHub repository URL"
                className="h-12 rounded-lg border-border bg-background pr-4 pl-12 text-[16px] shadow-sm placeholder:text-muted-foreground focus-visible:ring-2 md:text-[15px] dark:bg-card dark:shadow-none"
                onChange={(event) => {
                  onRepoUrlChange(event.target.value);
                }}
                onPaste={onRepoUrlPaste}
                placeholder="Paste repo URL or search"
                type="search"
                value={repoUrl}
              />
            </div>
            {repoUrlError ? <p id="repo-url-error" className="m-0 text-sm text-destructive">{repoUrlError}</p> : null}
            {searchStatusMessage ? (
              <p
                aria-live="polite"
                className={`m-0 text-sm ${searchStatus === "error" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {searchStatusMessage}
              </p>
            ) : null}
          </form>
        </div>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3" aria-label="Repositories">
          {isSearchLoading
            ? (
                <>
                  <span className="sr-only">Searching GitHub</span>
                  {Array.from({ length: 9 }).map((_, index) => (
                    <RepoCardSkeleton key={index} />
                  ))}
                </>
              )
            : isSearching
            ? searchResults.map((repo) => (
                <RepoCardLink
                  href={getRepoHrefFromRepoUrl(repo.repoUrl)}
                  key={repo.fullName}
                >
                  <RepoCard
                    description={repo.description ?? "No GitHub description"}
                    fullName={repo.fullName}
                    iconSrc={getRepositoryIconSrc(repo.fullName, repo.iconSrc)}
                    starCount={repo.starCount ?? undefined}
                  />
                </RepoCardLink>
              ))
            : (
                <>
                  {featuredRepoCards.map((repo) => (
                    <RepoCardLink
                      href={getRepoHrefFromRepoUrl(repo.repoUrl)}
                      key={repo.fullName}
                    >
                      <RepoCard
                        description={repo.description}
                        fullName={repo.fullName}
                        iconSrc={getRepositoryIconSrc(repo.fullName, repo.iconSrc)}
                        starCount={repo.starCount ?? undefined}
                        starLabel={repo.starLabel}
                      />
                    </RepoCardLink>
                  ))}
                  <CloneOpenWikiCard />
                </>
              )}
        </section>
      </section>
    </main>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.66.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.32 9.32 0 0 1 12 6.97c.85 0 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.95.68 1.92v2.79c0 .27.18.59.69.49A10.17 10.17 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

function RepoGlyph({
  fullName,
  iconSrc,
}: {
  fullName: string;
  iconSrc: string;
}) {
  const [owner, name] = fullName.split("/");
  const label = (name?.[0] ?? owner?.[0] ?? "?").toUpperCase();

  return (
    <span className="grid h-5 w-5 place-items-center overflow-hidden rounded-[4px] border bg-muted text-[11px] font-semibold text-muted-foreground">
      <img alt="" className="h-full w-full object-cover" src={iconSrc} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function RepoCard({
  description,
  fullName,
  iconSrc,
  indexedLabel,
  starCount,
  starLabel,
}: {
  description: string;
  fullName: string;
  iconSrc: string;
  indexedLabel?: string;
  starCount?: number;
  starLabel?: string;
}) {
  const stars = starLabel ?? (starCount === undefined ? "—" : formatStarCount(starCount));

  return (
    <Card className="group min-h-34 justify-between gap-6 overflow-hidden rounded-lg border border-border bg-background py-0 shadow-sm ring-0 transition-colors hover:border-foreground/25 hover:bg-muted/20 dark:bg-card dark:shadow-none dark:hover:bg-card">
      <CardHeader className="min-w-0 gap-3 px-4 pt-4">
        <RepoGlyph fullName={fullName} iconSrc={iconSrc} />
        <div className="grid min-w-0 gap-1">
          <CardTitle className="truncate font-mono text-[15px] leading-6 font-medium tracking-[-0.03em]">
            {fullName}
          </CardTitle>
          <CardDescription className="truncate text-[15px] text-muted-foreground">{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex items-center justify-between px-4 pb-4">
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Star className="h-3.5 w-3.5 fill-current opacity-50" />
          {stars}
        </span>
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
          {indexedLabel}
        </span>
      </CardContent>
    </Card>
  );
}

function RepoCardLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <Link
      className="block cursor-pointer appearance-none border-0 bg-transparent p-0 text-left"
      href={href}
      prefetch
    >
      {children}
    </Link>
  );
}

function CloneOpenWikiCard() {
  return (
    <a
      aria-label="Clone OpenWiki on GitHub"
      className="block cursor-pointer appearance-none border-0 bg-transparent p-0 text-left"
      href={openWikiGitHubUrl}
      rel="noreferrer"
      target="_blank"
    >
      <Card className="group min-h-34 items-center justify-center gap-4 overflow-hidden rounded-lg border border-dashed border-border bg-background px-4 py-6 text-center shadow-sm ring-0 transition-colors hover:border-foreground/30 hover:bg-muted/20 dark:bg-card dark:shadow-none dark:hover:bg-card">
        <span className="grid h-10 w-10 place-items-center rounded-full border border-border bg-muted text-foreground transition-colors group-hover:border-foreground/25 group-hover:bg-muted/80">
          <Plus className="h-4 w-4" />
        </span>
        <CardHeader className="w-full min-w-0 gap-1 px-0 pt-0">
          <CardTitle className="font-mono text-[15px] leading-6 font-medium whitespace-nowrap tracking-[-0.03em]">
            Clone OpenWiki
          </CardTitle>
          <CardDescription className="text-[15px] leading-6 text-muted-foreground">
            Generate wikis for your own repos
          </CardDescription>
        </CardHeader>
      </Card>
    </a>
  );
}

function RepoCardSkeleton() {
  return (
    <Card
      aria-hidden="true"
      className="min-h-34 justify-between gap-6 overflow-hidden rounded-lg border border-border bg-background py-0 shadow-sm dark:bg-card dark:shadow-none"
    >
      <CardHeader className="min-w-0 gap-3 px-4 pt-4">
        <span className="h-5 w-5 animate-pulse rounded-[4px] bg-muted" />
        <div className="grid min-w-0 gap-2">
          <span className="h-4 w-3/5 animate-pulse rounded bg-muted" />
          <span className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        </div>
      </CardHeader>
      <CardContent className="flex items-center justify-between px-4 pb-4">
        <span className="h-4 w-14 animate-pulse rounded bg-muted" />
        <span className="h-4 w-8 animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  );
}

function getRepositoryIconSrc(fullName: string, iconSrc: string | null): string {
  if (iconSrc !== null && iconSrc.length > 0) return iconSrc;
  const owner = fullName.split("/")[0];
  return getGitHubOwnerAvatarFallbackUrl(owner ?? "");
}

function getRepoHrefFromRepoUrl(repoUrl: string): string {
  const parsed = parseGitHubRepoUrl(repoUrl);
  if (parsed === null) return "/";
  return getRepoHref(parsed);
}

function formatStarCount(value: number): string {
  if (value >= 1_000_000) return `${trimTrailingZero(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimTrailingZero(value / 1_000)}k`;
  return String(value);
}

function trimTrailingZero(value: number): string {
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, "");
}

function updateSearchQueryParam(value: string) {
  const url = new URL(window.location.href);
  const query = value.trim();
  if (query.length === 0) {
    url.searchParams.delete("q");
  } else {
    url.searchParams.set("q", query);
  }

  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
