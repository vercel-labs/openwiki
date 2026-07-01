import type { ReactNode } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import {
  DEPLOY_WITH_VERCEL_URL,
  OPENWIKI_REPOSITORY_FULL_NAME,
  OPENWIKI_REPOSITORY_URL,
} from "@/app/lib/deploy-url";

type OpenWikiNavbarProps = {
  mobileWikiNav?: ReactNode;
  showRepositoryLinkLabelOnMobile?: boolean;
  repo?: {
    activeMode?: "chat" | "wiki";
    chatHref?: string;
    href: string;
    iconSrc: string;
    label: string;
    wikiHref?: string;
  };
};

export function OpenWikiNavbar({
  mobileWikiNav,
  repo,
  showRepositoryLinkLabelOnMobile = false,
}: OpenWikiNavbarProps) {
  const repositoryLinkLabelClassName = showRepositoryLinkLabelOnMobile
    ? "inline min-w-0 truncate font-mono text-xs"
    : "hidden min-w-0 truncate font-mono text-xs lg:inline";
  const repositoryLinkIconClassName = showRepositoryLinkLabelOnMobile
    ? "h-3.5 w-3.5 shrink-0"
    : "hidden h-3.5 w-3.5 shrink-0 lg:block";
  const repositoryLinkClassName = `inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${
    showRepositoryLinkLabelOnMobile ? "max-w-[48vw] px-2" : "w-7 px-0 lg:w-auto lg:px-2"
  }`;

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-10 items-center justify-between gap-4 border-b bg-background px-3">
      <div className="flex min-w-0 items-center gap-3 text-sm">
        <a
          aria-label="Open Vercel"
          className="flex items-center text-foreground"
          href="https://vercel.com"
          rel="noreferrer"
          target="_blank"
          title="Vercel"
        >
          <VercelTriangleLogo className="h-3.5 w-3.5 shrink-0" />
        </a>
        <SlashIcon className="h-4 w-4 shrink-0 text-border" />
        <Link className="font-medium text-foreground" href="/">
          <span>OpenWiki</span>
        </Link>
        {repo === undefined ? null : (
          <>
            <SlashIcon className="h-4 w-4 shrink-0 text-border" />
            <Link
              className="flex min-w-0 items-center gap-2 font-mono text-[13px] text-muted-foreground"
              href={repo.href}
            >
              <img alt="" className="h-4 w-4 rounded-[3px] bg-muted" src={repo.iconSrc} />
              <span className="truncate">{repo.label}</span>
            </Link>
            {repo.wikiHref !== undefined && repo.chatHref !== undefined ? (
              <nav className="hidden items-center gap-1 rounded-md border bg-background p-0.5 lg:flex" aria-label="Repository mode">
                <ModeLink active={repo.activeMode !== "chat"} href={repo.wikiHref}>
                  Wiki
                </ModeLink>
                <ModeLink active={repo.activeMode === "chat"} href={repo.chatHref}>
                  Chat
                </ModeLink>
              </nav>
            ) : null}
          </>
        )}
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <a
          aria-label="Deploy OpenWiki with Vercel"
          className="hidden h-7 w-7 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:inline-flex sm:w-auto sm:px-2"
          href={DEPLOY_WITH_VERCEL_URL}
          rel="noreferrer"
          target="_blank"
          title="Deploy OpenWiki with Vercel"
        >
          <VercelTriangleLogo className="h-3 w-3 shrink-0" />
          <span className="hidden text-xs font-medium sm:inline">Deploy</span>
        </a>
        {mobileWikiNav === undefined ? null : (
          <div className="shrink-0 lg:hidden">{mobileWikiNav}</div>
        )}
        <a
          aria-label={`Open ${OPENWIKI_REPOSITORY_FULL_NAME} on GitHub`}
          className={repositoryLinkClassName}
          href={OPENWIKI_REPOSITORY_URL}
          rel="noreferrer"
          target="_blank"
          title={OPENWIKI_REPOSITORY_FULL_NAME}
        >
          <GitHubMark className="h-3.5 w-3.5 shrink-0" />
          <span className={repositoryLinkLabelClassName}>{OPENWIKI_REPOSITORY_FULL_NAME}</span>
          <ExternalLink className={repositoryLinkIconClassName} />
        </a>
      </div>
    </header>
  );
}

function ModeLink({ active, children, href }: { active: boolean; children: ReactNode; href: string }) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`rounded-[calc(var(--radius-md)-2px)] px-2 py-0.5 text-xs leading-5 transition-colors ${
        active ? "bg-muted text-foreground shadow-sm dark:bg-input/70" : "text-muted-foreground hover:text-foreground"
      }`}
      href={href}
    >
      {children}
    </Link>
  );
}

function VercelTriangleLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M8 1L16 15H0L8 1Z" />
    </svg>
  );
}

function SlashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.01526 15.3939L4.3107 14.7046L10.3107 0.704556L10.6061 0.0151978L11.9849 0.606077L11.6894 1.29544L5.68942 15.2954L5.39398 15.9848L4.01526 15.3939Z"
      />
    </svg>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.66.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.32 9.32 0 0 1 12 6.97c.85 0 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.95.68 1.92v2.79c0 .27.18.59.69.49A10.17 10.17 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
