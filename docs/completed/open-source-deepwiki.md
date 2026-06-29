# Open-Source DeepWiki Plan

## Goal

Build OpenWiki as an open-source, self-hostable system that turns a Git repository into a navigable wiki with grounded chat.

The product should help a developer answer:

- What does this repository do?
- How is it organized?
- Where is a concept implemented?
- What should I read before changing a feature?
- Which docs are stale after a code change?

## Product Principles

1. **Source-grounded by default.**
   Every generated page and chat answer should cite files, symbols, commits, or docs. Unsupported claims should be avoided or clearly marked.

2. **Open core, portable runtime.**
   The app should run locally and on Vercel. Repo metadata, generated pages, source artifacts, and job state should use replaceable storage adapters.

3. **Incremental over batch-only.**
   Initial indexing can be batch-based, but the architecture should support webhook-driven updates from pushes and PRs.

4. **Small repos first, large repos deliberately.**
   Start with repos that fit in a straightforward clone/index workflow. Add sharding, queues, and cache invalidation once the data model is stable.

## User Experience

### Repository Home

The home page for a repo should show:

- repo summary
- generated table of contents
- key systems/modules
- recent indexing status
- confidence or freshness indicators
- entry points for chat and page generation

### Wiki Pages

Wiki pages should include:

- human-readable explanation
- source citations inline or in a side panel
- related pages
- key files and symbols
- freshness metadata, such as indexed commit SHA

### Chat

Chat should be repo-aware and citation-heavy:

- answers cite source files and wiki pages
- follow-up questions preserve session context
- the UI can jump from an answer citation to the relevant wiki page or source file

## Architecture

OpenWiki keeps the current two-app split:

- `apps/web`: Next.js UI, repo dashboards, page rendering, browser-facing API routes
- `apps/server`: eve agent server, long-running analysis workflows, model/tool orchestration

The browser talks only to `apps/web`. `apps/web` talks to `apps/server` with the eve client and Vercel OIDC.

Add shared packages once persistence begins:

- `packages/domain`: typed domain models and validation schemas shared by web and server.
- `packages/storage`: Neon and Blob repository functions, with no React, Next.js, or eve imports.
- `packages/github`: GitHub URL normalization and GitHub App helpers once private repos arrive.

This keeps persistence out of `apps/web` components and out of ad hoc eve tool files while still
letting both deployed services read and write the same product state.

### eve-Native Boundary

Repo understanding should be owned by the eve app, not by the web app.

The web app should:

- validate the shape of a GitHub repo URL
- choose the repo and session
- call the eve server with the repo URL and user message
- render wiki pages, citations, and chat output

The eve server should:

- clone or fetch the repo in its sandbox
- build and persist source inventories and structured indexes
- expose deterministic indexing helpers for product state transitions
- use eve's built-in sandbox and file tools for model-guided exploration
- generate wiki pages and citation bundles
- answer chat questions from persisted artifacts and source files in the prepared sandbox workspace

This matters because eve gives every agent one sandbox, framework file tools, authored tools,
durable sessions, and runtime context. OpenWiki should lean into that model instead of doing
GitHub API file fetching inside `apps/web`.

### Service Ownership

`apps/web` owns product flows:

- repo selection and add-repo UI
- wiki page rendering
- read APIs for dashboards and route handlers
- invoking eve with trusted repo context

`apps/server` owns agent execution:

- sandbox clone/fetch
- source inspection tools
- generated wiki drafts
- citation validation
- index and refresh workflows
- writing generated artifacts through shared storage functions

Neither app should own storage directly. They should import `packages/storage`, which exposes
intent-named operations such as `createRepository`, `startIndexJob`, `putArtifact`,
`createWikiPageRevision`, and `publishWikiPageRevision`.

Avoid making `apps/server` call back into `apps/web` to persist results. That would make the agent
runtime depend on the UI deployment, adds another internal auth hop, and makes long-running
workflows more fragile. Also avoid making `apps/web` do repo indexing just because it owns the
database; that puts source-analysis work on the wrong side of the eve boundary.

### Authored eve Slots

OpenWiki should use these eve authored slots:

- `agent/system.md`: always-on instructions for source-grounded answers, citations, and uncertainty.
- `agent/channels/internal/index-repository.ts`: structured internal entrypoint for deterministic indexing.
- `agent/lib/`: shared parsing, GitHub URL normalization, repo path helpers, and storage clients.
- `agent/sandbox/sandbox.ts`: sandbox backend and network policy. The Vercel backend should allow GitHub egress for clone/fetch operations.

The built-in eve HTTP route is good for basic chat, but it only accepts the framework message
payload. For robust repo context, OpenWiki should either encode the selected repo URL into the
message in the short term or add an authored OpenWiki channel route that accepts `{ repoUrl,
message }`, derives the continuation token, and stores the repo selection as durable channel
context for tools to read.

### Core Domains

1. **Repository**
   Tracks provider, owner, name, default branch, visibility, and current indexed revision.

2. **Index Job**
   Represents a clone, parse, source-index, outline, page-generation, or regeneration run.

3. **Source Graph**
   Stores files, symbols, imports, ownership hints, docs, and relationships discovered from the repo.

4. **Wiki Page**
   Stores generated content, source citations, related pages, and freshness metadata.

5. **Chat Session**
   Stores conversation state, selected repo, referenced pages, and eve continuation/session cursor.

## Ingestion Pipeline

Start GitHub-only. Public GitHub repository URLs are the first supported input; private repos and other Git providers come after the GitHub App milestone.

### MVP Pipeline

1. Accept a GitHub repository URL.
2. Pass the repo URL to the eve server as selected repo context.
3. Run deterministic eve code that clones or updates the repository in the agent sandbox.
4. Build a file inventory with language, size, and path metadata.
5. Build a structured source index from files, symbols, exports, routes, docs headings, package metadata, and dependency edges.
6. Store immutable source-index artifacts in Blob and normalized pointers/metadata in Neon.
7. Generate a repository map and initial wiki outline from the structured index.
8. Generate first-pass pages for the most important modules.
9. Persist indexed commit SHA, wiki page revisions, citations, and generated artifacts.

### Later Pipeline

- GitHub App installation for private repos and webhooks
- incremental re-indexing from changed files
- PR-aware temporary indexes
- stale-page detection when cited files change
- background regeneration queue
- per-language symbol extraction with Tree-sitter or language servers
- optional semantic embeddings as a fuzzy retrieval layer once structured retrieval and citations work

## Retrieval Strategy

Use layered retrieval instead of one vector search:

1. **Exact metadata lookup**
   Match file paths, symbols, package names, routes, and page slugs from Neon/source-index metadata.

2. **Lexical search**
   Use bounded lexical search over the sandbox working copy.

3. **Structured source lookup**
   Read relevant files, headings, exports, routes, and symbol neighborhoods from the cloned repo and source index.

4. **Graph expansion**
   Add neighboring files, imports, referenced symbols, and linked wiki pages.

5. **Optional semantic retrieval**
   Use embeddings later for fuzzy discovery, not as the foundational storage or citation model.

6. **Answer synthesis**
   Ask the model to answer only from retrieved context, cite sources, and state uncertainty.

## eve Agent Responsibilities

The eve server should own model-heavy and workflow-heavy work:

- public GitHub repo clone/fetch inside the sandbox
- repo inventory and structured source-index generation
- repo understanding and page outline generation
- page drafting and refresh from source-index artifacts
- citation validation
- chat answer synthesis
- tool-driven source lookup
- long-running indexing progress

The web app should own:

- repository selection
- UI state
- persistence APIs
- display of generated pages and citations

The web app should not own:

- GitHub tree walking
- source file selection
- source file reads
- repo indexing heuristics
- model-facing repo context construction

## Storage

Start with both Neon and Blob.

### Storage Ownership

Use Neon as the source of truth for relational state and current pointers. Use Blob for immutable
large artifacts.

Do **not** put all persistence in `apps/web`. The web app needs read/write access for product
flows, but the eve server also needs write access because it produces indexes, generated pages, and
citation bundles. Both should use the same shared storage package.

Do **not** treat the eve sandbox filesystem as durable product storage. The sandbox working copy is
execution state. Anything the product needs later must be written to Blob and referenced from Neon.

### Neon

Use Neon Postgres through `@neondatabase/serverless` with lazy client initialization in
`packages/storage`. Prefer the HTTP driver for simple one-shot queries and route-handler reads.
If a later workflow needs complex transactions, add a Node runtime pool deliberately.

Initial tables:

- `repositories`
  - `id`
  - `provider` (`github` for MVP)
  - `owner`
  - `name`
  - `full_name`
  - `default_branch`
  - `visibility`
  - `github_url`
  - `current_indexed_revision_id`
  - timestamps
- `repo_revisions`
  - `id`
  - `repository_id`
  - `branch`
  - `commit_sha`
  - `source_index_artifact_id`
  - `file_inventory_artifact_id`
  - `indexed_at`
- `index_jobs`
  - `id`
  - `repository_id`
  - `ash_session_id`
  - `status`
  - `started_at`
  - `finished_at`
  - `error_message`
- `artifacts`
  - `id`
  - `kind` (`file_inventory`, `source_index`, `wiki_markdown`, `wiki_blocks`, `citations`, `repo_archive`, `debug_log`)
  - `blob_key`
  - `blob_url`
  - `content_type`
  - `sha256`
  - `byte_size`
  - `created_by_job_id`
  - timestamps
- `source_files`
  - `id`
  - `repository_id`
  - `repo_revision_id`
  - `path`
  - `language`
  - `size`
  - `hash`
- `source_symbols` (can start sparse)
  - `id`
  - `source_file_id`
  - `name`
  - `kind`
  - `start_line`
  - `end_line`
- `wiki_pages`
  - `id`
  - `repository_id`
  - `slug`
  - `title`
  - `current_revision_id`
  - timestamps
- `wiki_page_revisions`
  - `id`
  - `wiki_page_id`
  - `repo_revision_id`
  - `content_artifact_id`
  - `citations_artifact_id`
  - `generated_by_job_id`
  - `status`
  - timestamps
- `citations`
  - `id`
  - `wiki_page_revision_id`
  - `source_file_id`
  - `path`
  - `start_line`
  - `end_line`
  - `quote_hash`
- `chat_sessions`
  - `id`
  - `repository_id`
  - `ash_session_id`
  - `ash_continuation_token`
  - timestamps

### Blob

Use Vercel Blob through `@vercel/blob` from `packages/storage`. Store generated artifacts with
content-addressed or revision-addressed keys. Prefer immutable writes and Neon pointer swaps over
mutating blobs in place.

Initial key shapes:

- `repos/{repositoryId}/revisions/{commitSha}/file-inventory.json`
- `repos/{repositoryId}/revisions/{commitSha}/source-index.json`
- `repos/{repositoryId}/revisions/{commitSha}/repo-archive.tar.zst`
- `repos/{repositoryId}/wiki/{pageId}/revisions/{pageRevisionId}.md`
- `repos/{repositoryId}/wiki/{pageId}/revisions/{pageRevisionId}.blocks.json`
- `repos/{repositoryId}/wiki/{pageId}/revisions/{pageRevisionId}.citations.json`
- `jobs/{indexJobId}/debug-log.txt`

Page bodies can be Markdown, structured blocks, or both. Start with Markdown plus a citations JSON
artifact, then add structured blocks only if rendering needs richer page structure.

### Write Flow

For index and page generation:

1. `apps/web` creates or finds the `repositories` row and starts an `index_jobs` row.
2. `apps/web` invokes eve with `repositoryId`, `repoUrl`, and `indexJobId`.
3. `apps/server` clones/fetches in the sandbox.
4. `apps/server` writes file inventory/source index/page artifacts to Blob through `packages/storage`.
5. `apps/server` writes Neon rows for artifacts, source files, page revisions, and citations.
6. `apps/server` atomically updates `current_indexed_revision_id` and `current_revision_id` pointers only after required artifacts exist.
7. `apps/web` revalidates affected tags/routes after the job completes.

If a job fails after Blob writes but before pointer updates, users keep seeing the previous
published revision. Orphaned artifacts can be cleaned up by a later maintenance job.

### Static Rendering And Caching

Next.js should render wiki pages from Neon current pointers and Blob-backed page artifacts:

1. Page route receives `{ owner, repo, slug }`.
2. Server Component reads `wiki_pages.current_revision_id` from Neon.
3. It reads the current page body and citations artifact from Blob.
4. It renders the page and caches it by tags such as:
   - `repo:{repositoryId}`
   - `repo:{repositoryId}:page:{pageId}`
   - `repo:{repositoryId}:revision:{commitSha}`
5. Index/page generation completion revalidates the affected tags.

The wiki can therefore be statically served from cached render output even though the source of
truth is Neon + Blob, not checked-in markdown files.

### Environment Variables

Both `apps/web` and `apps/server` need storage env vars because both use `packages/storage`:

- `DATABASE_URL`
- `BLOB_READ_WRITE_TOKEN`

Only server-side code may read these. Do not expose them through `NEXT_PUBLIC_*`.

Local development should support a storage adapter mode:

- default production adapter: Neon + Vercel Blob
- local adapter option: local Postgres or SQLite + filesystem-backed artifacts

The adapter boundary should live in `packages/storage`, not in React components or eve tool files.

## Access And Service Boundaries

For the MVP, OpenWiki should not add app-level user authentication or repo permissions. The
deployment can be protected by Vercel Deployment Protection, and anyone who can access that
deployment can use the app.

OpenWiki should still keep service and provider boundaries explicit:

1. Browser to web app: allowed by deployment access; no in-app user auth for now.
2. Web app to eve server: Vercel OIDC service auth.
3. Web app or server to Git provider: public GitHub access for the MVP.
4. Server to model provider: AI Gateway/OIDC or configured provider credentials.

When private repositories arrive, add a GitHub App and repo-level authorization deliberately
rather than threading user identity through the initial public-repo flow.

## MVP Milestones

### Milestone 1: Repo-Aware Chat

- Add a repo URL input.
- Pass selected repo context from web to eve.
- Add eve tools to clone/fetch a public GitHub repo in the sandbox.
- Add eve tools for bounded file inventory, lexical search, and file reads.
- Let the agent retrieve relevant files with tools and answer with citations.
- Store one chat session per repo.

### Milestone 2: Generated Wiki Outline

- Generate a table of contents from the file inventory.
- Create pages for top-level systems.
- Render pages in the web app.
- Store citations and indexed commit SHA.

### Milestone 3: Page Refresh

- Regenerate a page on demand.
- Show freshness when the repo SHA changes.

### Milestone 4: GitHub App

- Support private repos.
- Receive push webhooks.
- Trigger incremental indexing.
- Add repo permissions once private repositories are supported.

### Milestone 5: Open-Source Self-Hosting

- Add local setup docs.
- Provide storage adapter defaults.
- Add deployment docs for Vercel.
- Document model/provider configuration.

## Open Questions

- Should generated pages be stored as Markdown, structured blocks, or both?
- What belongs inline in Neon versus as immutable Blob artifacts?
- What local Blob-compatible adapter should we use for self-hosted development?
- Should Milestone 1 use the framework HTTP route with repo URL embedded in the message, or introduce an authored OpenWiki channel route immediately for structured `{ repoUrl, message }` input?
- How should the eve sandbox working copy be keyed: per session, per repo, per indexed SHA, or a shared template plus per-session checkout?
- Should public repo clone/fetch use `git` in the sandbox, GitHub archive downloads, or a GitHub App/API path once private repos arrive?
- How much source code should be visible in the UI versus only cited?

## Near-Term Implementation Plan

1. Add a minimal repo model and repo selection UI.
2. Move GitHub tree walking and file fetching out of `apps/web`.
3. Add an eve sandbox/tool path for cloning a public GitHub repo.
4. Add eve tools for file inventory, lexical search, and bounded file reads.
5. Update chat so the selected repo is passed to eve and source context is gathered by eve tools.
6. Add Neon-backed records for repositories, index jobs, wiki pages, page revisions, and citations.
7. Add Blob-backed storage for source index artifacts and generated wiki page bodies.
8. Add a wiki page route and generate the first repo overview page.
