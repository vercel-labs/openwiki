# Indexing And Workflow Plan

## Goal

Make OpenWiki indexing reliable, observable, and durable.

The current product shape is right:

- `apps/web` owns the user-facing product flow, static page rendering, and revalidation.
- `apps/server` owns source-grounded agent work and repository inspection.
- `packages/storage` owns Neon and Blob persistence for both apps.

The missing part is orchestration. Indexing is long-running, failure-prone, and currently too dependent on one HTTP request plus a model deciding to call the right tool. We should make indexing a first-class job flow with explicit status, retries, progress, and revalidation.

## Current State

### What Works

- The homepage reads repositories from Neon with `listRepositories()`.
- Repo pages read wiki metadata from Neon and markdown/citations from Blob through `getRepositoryWiki()`.
- `POST /api/repositories` creates or updates the repository row and creates an index job.
- The web app calls the eve server with Vercel OIDC for chat.
- Custom model-visible repo tools have been removed. Repository setup and indexing should be deterministic product operations; chat should use eve's built-in sandbox and file tools against a prepared workspace.
- The UI can navigate to `/repos/:owner/:repo`.
- `revalidatePath("/")` is wired after repository creation. Repo-page revalidation should happen after the indexing job publishes a current wiki revision.

### What Failed In Runtime Testing

The add-repo UI created the Neon repository row, but no wiki page was published.

Observed state:

- Repository exists in Neon.
- `currentIndexedRevisionId` remains `null`.
- `getRepositoryWiki()` returns no pages and no current page.
- The repo page renders: "This repository exists in Neon, but no Blob-backed wiki page has been published yet."

Root cause from eve stream events:

```text
bash: git: command not found
```

The model did call the old wiki-generation tool, but the tool failed inside the sandbox when trying to use `git`.

### Current Architectural Weaknesses

1. **Indexing is synchronous from the browser-facing route.**
   `POST /api/repositories` can take 30+ seconds and currently waits for eve before responding.

2. **Indexing invocation was prompt-mediated.**
   The route used to tell the agent to call a named wiki-generation tool. That has been removed because the product should not depend on prompt compliance for a core state transition.

3. **Job status is incomplete.**
   Jobs can be created and marked failed/completed, but the UI does not expose status, progress, or actionable errors.

4. **Repository hydration is underspecified.**
   The local eve sandbox is `just-bash`, which is the right MVP backend, but it should not be treated as a full Linux machine with `git`. We need deterministic code that writes repository files into the eve workspace before the model or indexer reads them.

5. **Revalidation happens too late and in the wrong shape.**
   Revalidation should happen after the durable indexing job publishes new current pointers, not after a fragile request-bound agent turn.

## Product Requirements

### User-Facing Requirements

Adding a repo should:

1. Validate the GitHub URL.
2. Create or find the repository row.
3. Start an indexing job quickly.
4. Return immediately with `{ repository, job, runId }`.
5. Navigate to the repo page.
6. Show job status:
   - queued
   - hydrating workspace
   - inventorying
   - generating wiki
   - publishing
   - completed
   - failed
7. Update the page when indexing completes.
8. Show a clear error if indexing fails.

Refreshing a repo should:

1. Create a new index job for the existing repo.
2. Preserve the currently published wiki while the new job runs.
3. Publish atomically by updating `repositories.current_indexed_revision_id` only after all required artifacts exist.
4. Revalidate `/` and `/repos/:owner/:repo`.

### System Requirements

- Indexing must survive request timeouts and process restarts.
- Every publish must be tied to:
  - repository id
  - index job id
  - workflow run id, if using Workflow
  - eve session id, if using eve agent execution
  - commit SHA
- Failures must be durable and visible from Neon.
- Blob artifacts should be immutable by revision key.
- Static pages should read only current pointers from Neon and artifact bodies from Blob.
- The browser should never talk directly to `apps/server`.

## Recommended Architecture

Use one eve-owned indexing run in `apps/server` as the long-running orchestration unit.

The browser-facing web route should not wait for indexing to finish. It should create durable product state, start an eve indexing run, store the eve session id on the job, and return immediately.

This gives a clean split:

- **Web answers:** what repo/job exists, what static route should render, and what job status should the user see?
- **eve answers:** how should this repo be understood, outlined, and explained?
- **Storage answers:** what wiki revision is current and where are page artifacts stored?

The important boundary is deterministic product state with agentic content:

- Deterministic: repository hydration, job phases, structured output validation, Neon/Blob persistence, publish pointers, and revalidation callbacks.
- Agentic: repository understanding, wiki outline, page relationships, prose, citations, diagrams, and page-level explanations.

### Why eve Owns The Indexing Run

Indexing is inherently an agent session:

- It needs a prepared source workspace.
- It benefits from subagents for separate units of understanding and writing.
- It needs a progress/event stream that can outlive one HTTP request.
- It may run for minutes when page generation fans out.
- It should keep sandbox lifecycle and agent state inside eve instead of splitting it across web and server.

The web app should treat eve like an async worker with durable run state. Web starts the run and then reads product state from Neon/Blob; it should not synchronously wait for the run's final output.

### eve Indexing Run Shape

Add one dedicated eve indexing entrypoint in `apps/server`, for example:

```text
apps/server/agent/channels/internal/start-index-repository.ts
```

Conceptual flow:

```ts
startIndexRepository(input)
  -> mark job running
  -> hydrate repository workspace deterministically
  -> run outline subagent
  -> validate outline
  -> run page subagents in parallel
  -> validate pages
  -> publish Blob artifacts and Neon revision metadata
  -> mark job completed
  -> notify web to revalidate affected paths
```

Suggested phases:

1. `start`
   - Receive `{ repositoryId, indexJobId, repoUrl }`.
   - Authenticate the web app with Vercel OIDC.
   - Mark the job `running`.
   - Store the eve session id on the job as soon as it is known.

2. `hydrate`
   - Fetch GitHub metadata and selected commit.
   - Fetch the recursive tree.
   - Select bounded source/docs files.
   - Write files into `/workspace/repos/<owner>/<repo>`.
   - Write `.openwiki/manifest.json`.
   - Persist source inventory metadata on the job or source index.

3. `outline`
   - Start one bounded outline subagent.
   - Input: repo manifest, file inventory, selected snippets, and instructions.
   - Output: structured JSON with repo summary, concepts, proposed pages, source paths per page, and confidence notes.
   - Validate the output before continuing.

4. `pages`
   - Start page subagents in parallel after the outline is accepted.
   - Use one subagent per page for small repos.
   - Batch pages for large repos to avoid unbounded fanout.
   - Each page subagent receives only its page spec, repo summary, and relevant source paths/snippets.
   - Each page returns structured JSON: title, slug, markdown, citations, related pages, and source coverage notes.

5. `publish`
   - Persist markdown and citation artifacts to Blob.
   - Persist wiki/page revision metadata to Neon.
   - Atomically advance current pointers only after required pages are written.
   - Preserve the previous current revision if publish fails.

6. `complete`
   - Update job status.
   - Store eve session id, source commit, page count, and failure counts.
   - Store partial page failures if the MVP allows partial publish later.

7. `revalidate`
   - eve cannot directly call `revalidatePath` unless it calls back into web.
   - Preferred MVP: eve calls an internal web endpoint after publish, authenticated by OIDC or a shared internal secret.
   - Web endpoint calls `revalidatePath("/")` and `revalidatePath("/repos/:owner/:repo")`.

8. `fail`
   - Store failure message and phase.
   - Classify as retryable or fatal where possible.
   - Keep the previous wiki revision visible.

### API Route Shape

`POST /api/repositories` should not wait for indexing to finish.

Target behavior:

```ts
export async function POST(request: NextRequest) {
  const input = parseRequest(request);
  const repository = await upsertRepository(input.repoUrl);
  const job = await createIndexJob(repository.id);

  const run = await startAshIndexRun({
    repositoryId: repository.id,
    indexJobId: job.id,
    repoUrl: repository.githubUrl,
  });

  await attachAshSessionToJob({
    indexJobId: job.id,
    ashSessionId: run.sessionId,
  });

  return Response.json({
    repository,
    job: { ...job, ashSessionId: run.sessionId },
  }, { status: 202 });
}
```

Add read endpoints:

```text
GET /api/repositories
GET /api/repositories/:owner/:repo
GET /api/index-jobs/:jobId
GET /api/index-jobs/:jobId/events
```

The repo page can poll the job endpoint while `currentIndexedRevisionId` is null, or subscribe to a lightweight event stream later.

## eve Indexing Boundary

### Decision: eve Parent Run With Subagent Fanout

The indexing route should start or resume one parent eve run. The parent run owns the high-level agent flow and fanout, but product side effects remain deterministic code.

Add an authored route in `apps/server` dedicated to starting indexing:

```text
agent/channels/internal/start-index-repository.ts
```

Desired request body:

```ts
type IndexRepositoryRequest = {
  repositoryId: string;
  indexJobId: string;
  repoUrl: string;
};
```

The route should not ask the model to decide whether indexing should happen. It should start a known indexing harness/agent entrypoint with structured input and return the eve session id quickly.

Inside the parent run:

1. Run deterministic repo hydration.
2. Start a bounded outline subagent.
3. Validate the outline schema.
4. Start page subagents in parallel.
5. Validate page schemas.
6. Publish artifacts with deterministic code.
7. Mark job completed/failed with deterministic code.

Each subtask must have a schema and validation boundary. The agent controls understanding and content; the product controls state transitions and writes.

### Parent Run Responsibilities

The parent run should be mostly orchestration and validation. It should not write prose itself except for fallback summaries.

Responsibilities:

- Maintain job phase updates.
- Create the prepared workspace once.
- Build source context packages for subagents.
- Start subagents with bounded inputs.
- Validate outputs.
- Retry or fail specific phases.
- Publish only validated artifacts.
- Emit progress events for the UI.

### Outline Subagent

Purpose: decide the first wiki structure from repo context.

Input:

- repository metadata
- file inventory
- skipped files summary
- README/package/entrypoint snippets
- optional lexical search results selected by deterministic code

Output:

```ts
type WikiOutline = {
  title: string;
  summary: string;
  pages: Array<{
    slug: string;
    title: string;
    purpose: string;
    sourcePaths: string[];
    priority: "required" | "recommended" | "optional";
  }>;
  concepts: Array<{
    name: string;
    description: string;
    sourcePaths: string[];
  }>;
};
```

Rules:

- Cap page count for MVP, for example 4 to 8 pages.
- Require one `overview` page.
- Reject source paths not present in the manifest.
- Reject duplicate slugs.
- Fall back to a deterministic single-page outline if validation fails repeatedly.

### Page Subagents

Purpose: generate source-grounded markdown pages from the accepted outline.

Input per page:

- one outline page spec
- repository summary
- relevant file snippets
- citations format
- writing rules

Output:

```ts
type WikiPageDraft = {
  slug: string;
  title: string;
  markdown: string;
  citations: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
  }>;
  relatedPages: string[];
  coverageNotes: string[];
};
```

Rules:

- Page subagents should not publish.
- Page subagents should not mutate job state.
- The parent run validates paths, markdown length, title/slug matching, and citation shape.
- The parent run decides whether a page failure blocks the whole publish.

### Persistence Boundary

Do not expose Neon or Blob writes as model-visible tools.

Publishing should be a deterministic function called by the parent run after validation:

```ts
await publishWikiRevision({
  repositoryId,
  indexJobId,
  ashSessionId,
  commitSha,
  outline,
  pages,
  sourceIndex,
});
```

This function owns:

- Blob keys and private/public access policy
- artifact checksums
- page records
- revision records
- current pointer update
- failure rollback

### Revalidation Boundary

`apps/web` owns ISR. eve should request revalidation after publishing rather than trying to import Next.js APIs.

Add an internal route:

```text
POST /api/internal/revalidate-repository
```

Request:

```ts
type RevalidateRepositoryRequest = {
  owner: string;
  repo: string;
  repositoryId: string;
  revisionId: string;
};
```

The route calls:

```ts
revalidatePath("/");
revalidatePath(`/repos/${owner}/${repo}`);
```

### Where Workflow Still Fits

Workflow is still a valid fallback if eve does not yet provide the subagent fanout or durable parent-run semantics we need. In that case:

- Workflow owns the product orchestration.
- eve owns only outline/page generation calls.
- The storage and revalidation boundaries stay the same.

For now, prefer the eve-native design because it keeps sandbox lifecycle, subagent state, and source-grounded reasoning in one runtime.

## Sandbox Strategy

### What We Need From The Sandbox

The indexing code and chat agent need:

- a durable working directory per eve session
- ability to hydrate public GitHub repo files into that workspace
- ability for the model to run lexical search with framework `bash`
- ability for the model to read bounded files with framework `read_file`
- stable repository-relative paths

### MVP Decision: Pin eve To `just-bash`

Use eve's local backend intentionally:

```text
apps/server/agent/sandbox/sandbox.ts
```

```ts
import { defineSandbox, localBackend } from "experimental-ash/sandboxes";

export default defineSandbox({
  backend: localBackend(),
});
```

This is still an eve sandbox. It is just backed by `just-bash`, not a Vercel Sandbox VM. The framework `bash`, `read_file`, and `write_file` tools all target the same `/workspace` namespace.

For MVP, do not require `git` inside the sandbox. Treat repo installation as deterministic workspace hydration:

1. Fetch repository metadata through the GitHub API.
2. Fetch the recursive tree for the selected commit.
3. Select bounded source/docs files.
4. Download raw file bodies.
5. Write those files into the eve workspace:

```text
/workspace/repos/<owner>/<repo>/...
```

Then tell the model:

```text
Repository prepared at /workspace/repos/vercel/ms.
Use bash and read_file against that workspace for source-grounded answers.
```

This keeps repository access in `apps/server`, gives the model normal eve workspace tools, and avoids custom model-visible repo tools.

### Deterministic Repo Hydration Helper

Add a helper in `apps/server/agent/lib/repo-workspace.ts`:

```ts
type PreparedRepositoryWorkspace = {
  commitSha: string;
  defaultBranch: string;
  files: Array<{ path: string; size: number }>;
  fullName: string;
  repoUrl: string;
  workspacePath: string;
};
```

Target API:

```ts
export async function prepareRepositoryWorkspace(input: {
  repoUrl: string;
  maxFiles?: number;
  maxFileBytes?: number;
}): Promise<PreparedRepositoryWorkspace> {
  const sandbox = await getSandbox();
  // Fetch GitHub metadata/tree/raw contents.
  // Write files into /workspace/repos/<owner>/<repo>/...
  // Return workspace path, commit SHA, and hydrated file manifest.
}
```

Rules:

- This is not a model-visible tool.
- It runs inside authored eve runtime execution because it uses `getSandbox()`.
- It should be idempotent for the same repo and commit.
- It should bound repo size and record skipped files.
- It should write a manifest file, for example:

```text
/workspace/repos/<owner>/<repo>/.openwiki/manifest.json
```

The manifest should include commit SHA, default branch, hydrated files, skipped files, and limits used for the run.

### Chat Flow With Prepared Workspace

For repo chat:

1. The web app sends `{ repoUrl, message, session }` to an OpenWiki-specific eve route.
2. The eve route calls `prepareRepositoryWorkspace(...)`.
3. The route invokes the agent with the selected repo URL and prepared `workspacePath`.
4. The model uses framework `bash` and `read_file` to inspect files.
5. The model cites repository-relative paths.

If the existing framework message route cannot run hydration before the harness turn, add a small authored channel route that accepts OpenWiki's structured chat payload and calls the runtime after hydration.

### Indexing Flow With Prepared Workspace

For indexing:

1. Workflow in `apps/web` creates the repository row and index job.
2. Workflow calls an internal eve indexing entrypoint with structured input.
3. The eve entrypoint calls `prepareRepositoryWorkspace(...)`.
4. eve runs an agentic repo-understanding pass over the hydrated workspace.
5. eve runs an agentic outline pass that returns structured page specs.
6. Workflow fans out page generation, ideally one child workflow or step per page.
7. Each page generation asks eve to inspect relevant files and draft markdown with citations.
8. Deterministic code validates each artifact and writes Neon/Blob through `packages/storage`.
9. Workflow marks the job completed and revalidates `/` and `/repos/:owner/:repo`.

The model should not be responsible for deciding whether indexing happened. It should be responsible for understanding the repository, designing the wiki outline, and drafting pages. Workflow and storage code decide when a job starts, retries, publishes, or fails.

### Comparison To `deepwiki-open`

`deepwiki-open` has a useful generation shape:

1. Clone and index the repository.
2. Generate a wiki structure from the file tree and README.
3. Generate each page separately from the page spec and relevant files.
4. Save the completed wiki structure and generated pages into a cache.

OpenWiki should keep that high-level shape but change where it runs:

- `deepwiki-open` coordinates generation from frontend React state; OpenWiki should coordinate it with Workflow.
- `deepwiki-open` uses local filesystem cache; OpenWiki should use Neon for metadata and Blob for immutable artifacts.
- `deepwiki-open` uses embeddings/FAISS for retrieval; OpenWiki should start with hydrated eve workspace access and built-in `bash` / `read_file`.
- `deepwiki-open` generates XML structure; OpenWiki should prefer schema-validated JSON objects.
- `deepwiki-open` generates pages concurrently in the browser; OpenWiki should fan out page-generation workflows or steps with durable progress.

### Later Option: Vercel Sandbox Backend With Git Runtime

When we need stronger isolation, private repo credentials, package installation, or a true checkout, switch the authored sandbox backend:

```ts
import { defineSandbox, vercelBackend } from "experimental-ash/sandboxes";

export default defineSandbox({
  backend: vercelBackend({
    runtime: "node24",
    networkPolicy: {
      allow: ["github.com", "api.github.com", "raw.githubusercontent.com"],
    },
  }),
});
```

At that point deterministic setup can use `git clone` / `git fetch` instead of GitHub API hydration. This is a later upgrade, not the MVP path.

### Later Option: Dynamic `Sandbox.create({ source: { url } })`

The user-provided example is directionally useful:

```ts
Sandbox.create({
  source: {
    url: repoUrl,
    type: "git",
  },
});
```

This is attractive because the sandbox starts from the repo checkout.

But the built-in eve `vercelBackend()` intentionally omits `source` because eve owns sandbox source/template management. Also, the repo URL is request-specific and only known after the user submits a repo. The authored sandbox definition is static.

To use this pattern inside eve, we likely need one of:

- a custom `SandboxBackend` that creates a sandbox from the selected repo URL
- an eve feature that lets a session provide source options to the sandbox backend
- a separate non-eve Vercel Sandbox path for repo checkout, with eve only consuming artifacts

This is promising for later, especially private repos, but it is not the lowest-risk MVP path.

### Rejected For MVP: Git-Capable Local Setup

Do not try to make the local `just-bash` backend install `git` with package-manager commands.

Reasons:

- `just-bash` is a virtual workspace, not a full machine image.
- Package installation makes local behavior fragile.
- GitHub API hydration is enough for public GitHub MVP.
- The deterministic helper can later swap its fetch implementation without changing the product flow.

## Storage Plan

### Neon Tables To Add Or Extend

Current tables are enough for a prototype, but indexing needs richer status.

Add fields to `index_jobs`:

```sql
workflow_run_id text,
phase text,
progress_current integer,
progress_total integer,
last_event_at timestamptz,
metadata_json jsonb
```

Suggested phases:

```text
queued
starting
hydrating_workspace
building_inventory
understanding_repo
generating_outline
generating_pages
publishing_artifacts
revalidating
completed
failed
```

Add helper functions in `packages/storage`:

- `attachWorkflowRunToJob`
- `updateIndexJobPhase`
- `completeIndexJob`
- `failIndexJob`
- `getIndexJob`
- `listIndexJobsForRepository`

### Blob Artifacts

Keep large immutable outputs in Blob:

```text
repos/{repositoryId}/revisions/{commitSha}/file-inventory.json
repos/{repositoryId}/revisions/{commitSha}/workspace-manifest.json
repos/{repositoryId}/index-jobs/{indexJobId}/repo-understanding.json
repos/{repositoryId}/index-jobs/{indexJobId}/wiki-outline.json
repos/{repositoryId}/wiki/{pageId}/revisions/{pageRevisionId}.md
repos/{repositoryId}/wiki/{pageId}/revisions/{pageRevisionId}.citations.json
```

Do not overwrite wiki revision artifacts. Current keys include revision ids, which is good.

Commit-keyed hydration artifacts can be reused for the same commit. Agent-generated artifacts should include `indexJobId` or a revision id because repeated agent runs can produce different outlines or prose.

## Static Rendering And ISR

### Desired Behavior

- `/` is static and reads the current repository list from Neon at generation time.
- `/repos/:owner/:repo` is static and reads current wiki pointers from Neon plus content from Blob at generation time.
- After a job publishes:
  - revalidate `/`
  - revalidate `/repos/:owner/:repo`
- The repo page can still include client components for chat and job polling.

### Page Behavior During Indexing

If a repo exists but no wiki is published yet:

- show the repo shell
- show current job status
- show "Indexing started" with phase/progress
- hide or soften wiki navigation until pages exist
- keep chat available only if repo tools can inspect the repo

If a refresh is running and an older wiki exists:

- show the current published wiki
- show a refresh-in-progress banner
- publish new pages atomically when complete

## UI Plan

### Home Page

Data source:

- Server component calls `listRepositories()`.
- No client fetch for the initial list.
- No hardcoded repo list.

Client behavior:

- Add repo dialog posts to `/api/repositories`.
- API returns quickly with `202`.
- UI navigates to repo page and/or shows job status.

Missing UI:

- search/filter over indexed repos
- status badges for indexing/failed/completed
- retry failed job button

### Repo Page

Data source:

- Server component calls `getRepositoryWiki()`.
- Related repos come from Neon.
- Wiki body comes from Blob.

Client behavior:

- `RefreshRepoButton` starts a new job.
- Job status component polls `GET /api/index-jobs/:jobId`.
- Chat remains a client component.

Potential components:

```text
RepositoryHome
AddRepositoryDialog
RepositoryStatusBadge
IndexJobStatusPanel
RefreshRepoButton
WikiMarkdown
RepoChat
```

## Implementation Milestones

### Milestone 1: Make Indexing Actually Publish

Goal: a public repo URL produces a visible wiki page.

Tasks:

1. Add `agent/sandbox/sandbox.ts` and pin it to `localBackend()`.
2. Add `prepareRepositoryWorkspace(...)` to hydrate public GitHub files into `/workspace/repos/<owner>/<repo>/`.
3. Add an agentic repo-understanding step that inspects the hydrated workspace and writes:
   - file inventory artifact
   - workspace manifest artifact
   - repo understanding artifact
4. Add an agentic outline step that writes a schema-validated wiki outline.
5. Add a first page-generation step that drafts at least one markdown page from the outline.
6. Add deterministic publishing code that writes:
   - wiki markdown artifact
   - citations artifact
   - repo revision
   - page revision
   - `repositories.current_indexed_revision_id`
7. Update `POST /api/repositories` or the Workflow step to fail if no wiki was published.
8. Add one integration-style smoke test or manual script that indexes `vercel/ms`.

Acceptance criteria:

- Add `https://github.com/vercel/ms`.
- Repo page shows generated markdown.
- `currentIndexedRevisionId` is non-null.
- Blob contains workspace manifest, repo understanding, outline, markdown, and citation artifacts.
- The hydrated workspace contains `/workspace/repos/vercel/ms/.openwiki/manifest.json`.
- No hardcoded fallback content appears.

### Milestone 2: Move Indexing To Workflow In `apps/web`

Goal: add-repo returns quickly and indexing survives the request.

Tasks:

1. Add Workflow SDK dependencies and Next integration.
2. Add `indexRepositoryWorkflow`.
3. Move storage and eve calls into `"use step"` functions.
4. Store `workflowRunId` on `index_jobs`.
5. Return `202` from `POST /api/repositories`.
6. Add `GET /api/index-jobs/:jobId`.
7. Add repo-page job status UI.
8. Revalidate static paths only after successful publish.

Acceptance criteria:

- Add repo request returns quickly.
- UI shows indexing status.
- A page refresh during indexing preserves status.
- Completed workflow revalidates static pages.
- Failed workflow shows durable error message.

### Milestone 3: Deterministic eve Index Entry Point

Goal: stop relying on a model prompt to decide control flow while still using the agent for understanding and content.

Tasks:

1. Add a structured eve indexing entrypoint.
2. Move repo hydration and publish logic into shared deterministic helpers.
3. Use `prepareRepositoryWorkspace(...)` before chat and indexing turns.
4. Add schema-validated agent subtasks:
   - `generateRepoUnderstanding`
   - `generateWikiOutline`
   - `generateWikiPage`
5. Use eve's built-in sandbox and file tools for chat and exploration instead of custom repo tools.
6. Let Workflow call the indexing entrypoint.

Acceptance criteria:

- Web workflow calls eve with structured input.
- eve returns structured understanding, outline, and page outputs.
- No "please call tool X" prompt is required for indexing.

### Milestone 4: Better Wiki Generation

Goal: produce a useful multi-page generated wiki, not just a README summary.

Tasks:

1. Expand repo understanding:
   - top-level directories
   - package manifests
   - app/routes
   - exports
   - important files
   - docs headings
2. Generate a richer outline with page dependencies and relevant file paths.
3. Fan out one page-generation workflow or step per outline page.
4. Validate citations and source coverage for each page.
5. Store page relationships.

Acceptance criteria:

- Repo page shows several generated pages.
- Citations point to real files.
- Chat can refer to generated pages and source files.

### Milestone 5: Incremental Refresh

Goal: re-index changed repos without regenerating everything.

Tasks:

1. Store indexed commit SHA.
2. Compare current default branch SHA.
3. Skip refresh if unchanged unless forced.
4. Add GitHub webhook support after GitHub App setup.
5. Track stale pages based on changed cited files.

Acceptance criteria:

- Refresh is no-op when commit SHA is unchanged.
- Changed repo publishes a new revision.
- Old wiki remains visible until new revision is complete.

## Open Questions

1. Does the existing framework message route allow repo hydration before the harness turn, or do we need an OpenWiki-specific authored chat route?
2. Does eve expose a deterministic way to invoke an authored indexing entrypoint with structured input outside a model turn?
3. Should `apps/web` use Workflow as the only indexing orchestrator, or should eve own indexing durability?
4. How much progress detail do we want in the UI for MVP?
5. Do we want to require `GITHUB_TOKEN` for public repos to avoid low anonymous rate limits?
6. Should Blob source artifacts be public or private for this MVP behind deployment protection?

## Recommendation

Use this staged plan:

1. **Fix publishing first.**
   Get one public repo from URL to generated wiki page, even if the API request still waits.

2. **Add Workflow in `apps/web`.**
   Make indexing durable, statusful, and request-independent.

3. **Make eve indexing deterministic.**
   Replace prompt-mediated tool calling with a structured eve indexing entrypoint that hydrates `/workspace/repos/<owner>/<repo>/`, then runs bounded agent subtasks for repo understanding, outline, and page drafting.

4. **Improve wiki quality.**
   Build multi-page, agent-generated wiki creation with page-level workflows, source-grounded citations, and durable publish semantics.

For the sandbox issue, pin the eve agent to `localBackend()` and hydrate public GitHub files into the `just-bash` workspace. Do not require `git` for the MVP.

Longer term, explore dynamic Vercel Sandbox `source: { type: "git", url }` through a custom eve backend or upstream eve feature. That would be a clean fit for public and private GitHub repo sandboxes, but it is probably not the fastest path to a working OpenWiki MVP.
