# Auto Update Plan

## Goal

Keep generated OpenWiki pages fresh when a connected GitHub repository changes.

There are two related but different products:

- **Default-branch auto update:** every push to the repository's configured/default branch can refresh the canonical wiki.
- **PR preview update:** every opened/synchronized PR can generate an isolated preview wiki for that PR, without replacing canonical docs.

The key rule: PR content should never advance `repositories.current_indexed_revision_id`. Only trusted default-branch updates should publish the canonical wiki.

## Current Fit

OpenWiki already has most of the manual indexing shape:

- `app/` owns the browser flow and starts indexing through `POST /api/repositories`.
- `agent/` exposes the embedded eve channel `POST /eve/v1/openwiki/index-repository`.
- `lib/storage.ts` has repositories, index jobs, repo revisions, page revisions, and current pointers.
- `repo_revisions.commit_sha` already records the source commit for a published wiki revision.

Auto update should reuse this path rather than inventing a second indexer. Webhooks should create or dedupe jobs, then dispatch the same eve indexing channel with a richer trigger payload.

## Product Shape

### Default Branch Push

When GitHub sends a push event for the connected repository:

1. Verify the GitHub webhook signature.
2. Ignore branch refs that are not the configured/default publish branch.
3. Compare the event `after` SHA with the currently indexed commit.
4. If the SHA is already indexed or already queued, acknowledge and do nothing.
5. Create an `index_jobs` row with trigger metadata.
6. Dispatch eve indexing for that exact ref/SHA.
7. Publish atomically by writing all artifacts first, then advancing the repository current pointer.
8. Revalidate `/`, `/repos/:owner/:repo`, and every published page path.

### Pull Request Preview

When GitHub sends `pull_request` events such as opened, reopened, synchronize, or ready_for_review:

1. Verify the webhook signature.
2. Create or update a PR preview record keyed by repository + PR number + head SHA.
3. Create a PR-scoped index job.
4. Dispatch eve indexing for the PR head SHA, optionally with base SHA metadata.
5. Publish into preview pointers, not canonical repository pointers.
6. Expose a preview URL such as `/repos/:owner/:repo/pr/:number` or `/preview/:previewId`.
7. Post or update a GitHub check run or PR comment with the preview link and job status.

When a PR closes:

- If merged, the later default-branch push should update canonical docs.
- If closed unmerged, mark the preview inactive and optionally expire its artifacts later.

## Storage Additions

Add explicit trigger and preview state rather than overloading existing rows.

Suggested schema additions:

- `github_installations`
  - installation id, account login, permissions snapshot, created/updated timestamps
- `repository_connections`
  - repository id, provider repo id, installation id, default branch, auto update mode, webhook enabled
- `webhook_deliveries`
  - GitHub delivery id, event name, repository id when known, status, error, received timestamp
- `index_jobs` additions
  - `trigger_type`: `manual`, `push`, `pull_request`
  - `trigger_id`: delivery id or synthetic manual id
  - `target_ref`: `refs/heads/main`, `refs/pull/123/head`, etc.
  - `target_sha`: exact commit to index
  - `pull_request_number`: nullable
  - `workflow_run_id`: nullable, if/when Workflow wraps the job dispatch
- `repo_previews`
  - repository id, PR number, head SHA, base SHA, status, current preview revision id, preview URL slug, updated timestamp

Keep `repo_revisions` immutable and commit-addressed. For canonical docs, `repositories.current_indexed_revision_id` points at the active revision. For PR previews, `repo_previews.current_preview_revision_id` points at the active preview revision.

## Webhook/API Surface

Add one GitHub webhook route in the Next app, because the app owns product state and can cheaply acknowledge GitHub:

```text
POST /api/github/webhook
```

Responsibilities:

- Read raw body and verify `X-Hub-Signature-256`.
- Deduplicate by `X-GitHub-Delivery`.
- Parse only supported event types.
- Resolve repository connection.
- Create/dedupe index jobs.
- Return 2xx quickly.
- Dispatch indexing in `waitUntil` or, for production durability, start a Workflow run.

Do not run model work in this route.

## Indexing Changes

The existing eve channel can support auto updates with a small input expansion:

```ts
{
  indexJobId: string;
  repositoryId: string;
  repoUrl: string;
  targetRef?: string;
  targetSha?: string;
  triggerType?: "manual" | "push" | "pull_request";
  pullRequestNumber?: number;
}
```

`getGitHubRepoSnapshot` should accept `targetSha` and fetch the tree for that exact commit. Manual runs can continue to resolve the current default branch.

Publishing needs a mode:

- `canonical`: update `repositories.current_indexed_revision_id`.
- `preview`: update `repo_previews.current_preview_revision_id`.

Both modes should write the same Blob artifacts and page revisions, but only canonical mode should replace the public repo wiki.

## Durability

MVP can use webhook route + `waitUntil` + existing eve indexing. That is enough to prove the product loop.

Production should wrap webhook-triggered indexing in a durable workflow:

1. Webhook route validates and records delivery.
2. Route starts `indexRepositoryWorkflow`.
3. Workflow steps create/dedupe the job, call the eve indexing channel, wait/poll for job completion, and update GitHub check/comment status.
4. Retryable failures such as GitHub 429s, transient eve start failures, or network errors retry automatically.
5. Fatal failures such as invalid repo permissions or deleted PR heads mark the job failed without retry loops.

The existing eve session can still own agentic generation; Workflow owns webhook orchestration and retries around it.

## GitHub Feedback

For default branch pushes:

- Optional commit status/check: `OpenWiki updated` with the canonical wiki URL.

For PRs:

- Prefer a GitHub Check Run named `OpenWiki preview`.
- Statuses:
  - queued: job created
  - in_progress: eve run started
  - completed/success: preview link
  - completed/failure: concise error message
- A sticky PR comment can be a later enhancement, but check runs are cleaner for repeated synchronize events.

## Security And Controls

- Require GitHub webhook signature verification before parsing.
- Store webhook secrets server-side only.
- Use GitHub App installation tokens for private repositories and API rate limits.
- Default to only auto-publishing the default branch.
- Make PR previews opt-in per repository if generation cost matters.
- Deduplicate aggressively by `(repository_id, trigger_type, target_sha, pull_request_number)`.
- Add a per-repository concurrency limit so rapid push storms collapse to the newest SHA.

## Rollout

### Phase 1: Commit-Aware Manual Indexing

- Add `targetSha` support to GitHub snapshot/indexing.
- Store trigger metadata on index jobs.
- Deduplicate manual reruns for the same commit.

### Phase 2: Webhook Ingestion

- Add `POST /api/github/webhook`.
- Verify signatures.
- Record deliveries.
- Support default-branch push events.
- Dispatch existing eve indexing.

### Phase 3: PR Preview Indexes

- Add `repo_previews`.
- Add preview publish mode.
- Add preview routes.
- Support `pull_request` opened/reopened/synchronize events.

### Phase 4: GitHub App Feedback

- Add check-run updates for queued/running/success/failure.
- Link PR preview pages.
- Mark previews inactive on PR close.

### Phase 5: Durable Workflow Wrapper

- Move webhook-triggered indexing orchestration into Workflow steps.
- Keep eve as the generation runtime.
- Add retry classification and observability around GitHub, eve start, publish, and revalidation.

## Open Questions

- Should default-branch auto update be immediate for every commit, or debounce rapid pushes for 1-5 minutes?
- Should PR previews generate the full wiki or only pages affected by changed files?
- How long should preview artifacts live after PR close?
- Should canonical auto updates require an OpenWiki config file in the repository?
- How should private repo permissions be reflected in public preview URLs?
