# OpenWiki

Generate a living, source-grounded wiki for any GitHub repository.

OpenWiki is a Next.js app backed by an [eve](https://eve.dev) agent. Give it a repository, and it plans a docs-style outline, writes source-cited pages, publishes a navigable wiki, and keeps published repositories fresh as the source changes.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fopenwiki%23environment-variables&project-name=openwiki&repository-name=openwiki&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fopenwiki%2Ftree%2Fmain&stores=%5B%7B%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%2C%22type%22%3A%22integration%22%7D%2C%7B%22access%22%3A%22private%22%2C%22type%22%3A%22blob%22%7D%5D)

## What You Get

- Source-grounded repository wikis with page-level citations.
- Docs-style navigation for large projects, including official-docs-shaped outlines when first-party docs exist.
- Repository chat that uses the same indexed source context.
- Featured wiki prerendering for fast public docs pages.
- Daily refresh scheduling through eve so stale repositories are regenerated without replacing the last good wiki.
- Built-in rate limiting for public generation.

## Deploy

The one-click deploy provisions:

- Neon Postgres for repository metadata, jobs, revisions, and chat state.
- Vercel Blob for generated wiki artifacts.

`GITHUB_TOKEN` is optional, but recommended for public repository API limits. OpenWiki intentionally rejects private repositories on public deployments.

After deployment, open the app and visit a route like:

```txt
/vercel/next.js
```

## Run Locally

Install dependencies:

```bash
pnpm install
```

Link the project and pull Vercel environment variables:

```bash
vercel link
vercel env pull .env.local --yes
```

Start the app:

```bash
pnpm dev
```

Open `http://127.0.0.1:3000`, paste a GitHub repository URL, or visit a repository route directly.

## Storage Setup

OpenWiki needs Postgres and Blob storage.

If your Vercel project already has the integrations from the deploy flow, `vercel env pull` is enough. Otherwise, provision them:

```bash
vercel integration add neon
vercel blob create-store openwiki-artifacts --access private --yes
vercel env pull .env.local --yes
```

For local-only smoke tests, you can store artifacts on disk:

```bash
OPENWIKI_LOCAL_ARTIFACTS=1 pnpm dev
```

Use local artifacts only with an isolated local database. Shared deployments will not be able to read files from your machine.

## Environment Variables

Required:

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string for repositories, jobs, revisions, and chat sessions. |
| `BLOB_STORE_ID` | Vercel Blob store for wiki artifacts. Preferred on Vercel and after `vercel env pull`. |

Useful locally:

| Name | Purpose |
| --- | --- |
| `BLOB_READ_WRITE_TOKEN` | Token-based Blob access for local development. |
| `OPENWIKI_LOCAL_ARTIFACTS` | Set to `1` to write artifacts to local disk for isolated smoke tests. |

Recommended:

| Name | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Raises GitHub API limits for public repositories. Use a token without private repository access on public deployments. |

Optional public access control:

| Name | Purpose |
| --- | --- |
| `OPENWIKI_DISABLE_REPOSITORY_CREATION` | Set to `1` to keep public repository creation read-only. Existing indexed wikis stay readable, but unknown or unindexed repository routes will not create DB rows or start wiki generation. |

These settings can be tuned for generation quality, cost, public rate limits, and refresh cadence. The defaults are meant to work well for a hosted demo or a fresh clone.

Optional model tuning:

| Name | Default | Purpose |
| --- | --- | --- |
| `OPENWIKI_INDEX_MODEL` | `openai/gpt-5.5` | Model used for outline and page generation. Use the strongest model you can afford here. |
| `OPENWIKI_AGENT_MODEL` | `openai/gpt-5.4-mini` | Model used by the lightweight app agent path. |

OpenWiki separates these defaults because wiki generation is quality-sensitive and benefits from a frontier reasoning model, while the lightweight app agent path should stay lower-latency and cheaper. Override either value if your provider or budget calls for a different tradeoff.

Optional rate-limit tuning:

| Name | Default |
| --- | --- |
| `OPENWIKI_GENERATION_RATE_LIMIT_ENABLED` | enabled |
| `OPENWIKI_GENERATION_RATE_LIMIT_CLIENT_HOURLY` | `10` |
| `OPENWIKI_GENERATION_RATE_LIMIT_CLIENT_DAILY` | `50` |
| `OPENWIKI_GENERATION_RATE_LIMIT_GLOBAL_HOURLY` | `120` |
| `OPENWIKI_GENERATION_RATE_LIMIT_REPO_COOLDOWN_MINUTES` | `10` |
| `OPENWIKI_CHAT_RATE_LIMIT_ENABLED` | enabled |
| `OPENWIKI_CHAT_RATE_LIMIT_CLIENT_HOURLY` | `40` |
| `OPENWIKI_CHAT_RATE_LIMIT_CLIENT_DAILY` | `200` |
| `OPENWIKI_CHAT_RATE_LIMIT_GLOBAL_HOURLY` | `600` |

Optional refresh tuning:

| Name | Default |
| --- | --- |
| `OPENWIKI_REFRESH_SCAN_LIMIT` | `100` |
| `OPENWIKI_REFRESH_ENQUEUE_LIMIT` | `3` |
| `OPENWIKI_REFRESH_GENERATOR_ENQUEUE_LIMIT` | `12` |
| `OPENWIKI_REFRESH_RETRY_COOLDOWN_HOURS` | `24` |

Set `OPENWIKI_GENERATION_RATE_LIMIT_ENABLED=0` or `OPENWIKI_CHAT_RATE_LIMIT_ENABLED=0` to disable that limiter, or set an individual numeric limit to `0` to disable that bucket.

## How It Works

OpenWiki runs as one Next.js app with an embedded eve agent:

- `next.config.ts` wraps the app with `withEve`.
- `agent/` contains the eve agent, indexing channel, schedules, prompts, and subagents.
- `app/api/repositories` accepts GitHub repositories and reserves index jobs.
- `agent/lib/indexing/run-index-job.ts` fetches repository context, discovers official docs when available, plans the wiki, generates pages, validates quality, and publishes a revision.
- `lib/storage.ts` stores durable state in Postgres and artifact bodies in Blob.
- Canonical wiki routes are `/:owner/:repo` and `/:owner/:repo/:slug`.
- Chat routes stay dynamic; published featured wiki routes can be prerendered during `next build`.

## Wiki Generation

Generation is intentionally staged:

1. Fetch repository metadata and a bounded source inventory from GitHub.
2. Read high-signal context files such as README files, package metadata, docs, configs, and entrypoints.
3. Discover first-party official docs indexes when a project has one.
4. Ask eve to plan a docs-style outline.
5. Normalize the outline so broad docs projects keep nested navigation and focused leaf pages.
6. Generate each page with visible source paths and structured citations.
7. Run deterministic quality checks for depth, citations, source-path validity, and navigation shape.
8. Publish the revision atomically, leaving the previous wiki visible until the new one is ready.

OpenWiki uses an adaptive page budget. Small libraries stay compact, medium projects get focused system coverage, and docs-heavy frameworks or platforms can generate 50+ source-backed pages when the repository and official docs index justify that depth. Higher page counts are reserved for real reader-facing topics, not file-by-file inventory.

## Keeping Wikis Fresh

OpenWiki generates wikis on demand, then refreshes them over time.

Production runs a daily eve schedule in `agent/schedules/refresh-repositories.ts`. The schedule:

- ensures featured repositories are tracked;
- refreshes repository metadata such as description and star count;
- compares the published commit SHA and generator version against the current repository state;
- queues stale repositories for regeneration;
- prioritizes featured repositories when a generator upgrade needs to backfill docs quality, using a larger generator catch-up budget than ordinary source-change refreshes.

The same refresh pipeline can be triggered manually:

```bash
curl -X POST http://127.0.0.1:3000/api/internal/refresh-repositories
```

Public repositories currently use scheduled polling. A future GitHub App can add webhook-triggered refreshes for repos that install it.

## Development Commands

```bash
pnpm typecheck
pnpm build
```

## Development Notes

- Keep generated pages source-cited. A page without concrete repository paths is not a good OpenWiki page.
- Bump `lib/wiki-generator-version.ts` whenever generation behavior changes enough that existing wikis should refresh.
- Prefer improving deterministic validation before relying on prompt wording alone.
