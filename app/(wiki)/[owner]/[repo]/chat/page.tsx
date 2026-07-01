import { OpenWikiNavbar } from "@/app/components/openwiki-navbar";
import { RepoChatFullPage } from "@/app/components/repo-chat-full-page";
import { getGitHubOwnerAvatarFallbackUrl, getRepoHref } from "@/lib/github-repo-url";

type RepositoryChatPageProps = {
  params: Promise<{
    owner: string;
    repo: string;
  }>;
  searchParams: Promise<{
    q?: string;
  }>;
};

export const dynamic = "force-dynamic";

export default async function RepositoryChatPage({ params, searchParams }: RepositoryChatPageProps) {
  const { owner, repo: repoName } = await params;
  const { q } = await searchParams;
  const repoLabel = `${owner}/${repoName}`;
  const repoUrl = `https://github.com/${owner}/${repoName}`;
  const repoHref = getRepoHref({ name: repoName, owner });
  const chatHref = `${repoHref}/chat`;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <OpenWikiNavbar
        repo={{
          activeMode: "chat",
          chatHref,
          href: repoHref,
          iconSrc: getRepositoryIconSrc(owner),
          label: repoLabel,
          wikiHref: repoHref,
        }}
      />
      <RepoChatFullPage initialQuestion={q} repoLabel={repoLabel} repoUrl={repoUrl} />
    </main>
  );
}

function getRepositoryIconSrc(owner: string): string {
  return getGitHubOwnerAvatarFallbackUrl(owner);
}
