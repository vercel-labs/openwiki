"use client";

import Link from "next/link";

type RepoChatProps = {
  chatHref: string;
  repoLabel: string;
};

export function RepoChat({ chatHref, repoLabel }: RepoChatProps) {
  return (
    <div className="fixed inset-x-4 bottom-4 z-50 mx-auto w-[min(640px,calc(100vw-32px))]">
      <Link
        aria-label={`Open chat for ${repoLabel}`}
        className="flex h-12 min-w-0 items-center gap-3 rounded-lg border border-border bg-background/95 px-5 text-sm text-muted-foreground shadow-[0_10px_36px_rgba(0,0,0,0.14)] backdrop-blur transition-colors hover:border-muted-foreground/50 hover:text-foreground dark:bg-background/90 dark:shadow-[0_10px_42px_rgba(0,0,0,0.42)]"
        href={chatHref}
        prefetch
      >
        <span className="min-w-0 flex-1 truncate">Ask a question...</span>
      </Link>
    </div>
  );
}
