# Wiki Generation Research Plan

## Goal

Make OpenWiki generate docs-site-quality wikis from repository source, keep those wikis trustworthy over time, and update them automatically as repositories change.

The product target is not a thin repository summary. A good generated wiki should feel like a real documentation site: clear navigation, source-grounded architecture pages, API and workflow explanations, relevant examples, testing and release signals, and citations that let a reader jump back to the code.

## Current Implementation Map

OpenWiki is a single Next.js app with an embedded eve runtime.

- `app/` owns the UI, browser-facing API routes, repository pages, chat pages, and revalidation endpoints.
- `agent/` owns the eve channels, indexing prompts, generation orchestration, and publish flow.
- `lib/` owns storage helpers and repository/wiki domain reads.
- Generated wiki markdown and citation artifacts are immutable by revision. Neon stores repository, job, revision, page, source-file, and artifact metadata. Vercel Blob stores artifacts in production; local development falls back to `.openwiki/artifacts/`.

The main indexing path is:

1. A browser or route calls `POST /api/repositories`.
2. The route parses the GitHub repository, upserts the repository row, creates an index job, and calls the embedded eve channel under `/eve/v1/openwiki/index-repository`.
3. `agent/channels/internal/index-repository.ts` validates the request and calls `runIndexRepositoryJob`.
4. `agent/lib/indexing/run-index-job.ts` hydrates the repository, builds a source inventory, creates context snippets, generates an outline, generates pages, validates outputs, and publishes.
5. `agent/lib/indexing/publish.ts` writes artifacts and revision metadata, advances the current wiki pointer only after artifacts exist, then calls the app's internal revalidation route.
6. Repository pages read current wiki state through storage helpers and render the generated markdown with citations and source references.

The key architectural split is deterministic orchestration plus agentic documentation:

- Deterministic: repository fetching, file filtering, context packing, job phases, schema parsing, quality checks, artifact writes, current-pointer updates, and revalidation.
- Agentic: identifying concepts, building the docs outline, explaining systems, connecting source files, and writing human-readable pages.

## How Wikis Are Generated

Generation should be source-first and repeatable enough to debug.

### Repository Hydration

The indexer resolves a repository and commit, fetches source metadata, filters files, and builds a workspace manifest. The manifest and source inventory are the evidence boundary for the model. If a file is not in the inventory or selected snippets, the model should not invent claims about it.

Research questions:

- Which file types and directories give the best signal for docs generation across libraries, frameworks, apps, CLIs, and monorepos?
- How should we balance README/docs files against source files, examples, tests, package metadata, and CI configuration?
- When a repository is huge, what source selection strategy preserves coverage without flooding the model context?

### Outline Generation

The outline generator receives repository metadata, file inventory, repository map, and selected context snippets. It returns structured JSON with:

- wiki title and summary
- major concepts
- nested navigation
- flat page list
- source paths for each page

The outline should scale by repository size:

- compact packages: focused pages such as Overview, API Surface, Runtime Behavior, Testing and Release Signals
- medium repositories: guides and subsystem pages
- large frameworks or monorepos: docs-like sections for architecture, runtime, compiler/build, APIs, data/caching, examples, testing, and contributor infrastructure

Research questions:

- What page taxonomy consistently produces useful docs across repository types?
- How do we prevent one-page summaries for large repos and over-splitting for compact packages?
- Should outline generation use a reviewer pass before page generation starts?

### Page Generation

Page workers receive one or more outline page specs plus targeted source snippets. They return structured page JSON with:

- slug
- title
- markdown
- structured citations
- coverage notes
- related pages

The markdown must include:

- one `#` title
- several `##` sections
- concrete `Sources:` lines in the prose
- a `## Relevant Source Files` section
- source-grounded explanations rather than generic commentary

The current system runs page workers in batches, validates every page, retries repair prompts when needed, and fails the whole publish if required pages are missing or below the quality bar. This is important: a failed generation should leave the previous good wiki visible instead of publishing a partial wiki.

Research questions:

- When should page generation use one page per worker versus grouped page batches?
- Which page types need special structure, such as API reference tables, command references, config references, diagrams, or examples?
- Can we derive lightweight symbols, exports, commands, routes, config keys, and test targets deterministically before model writing?

## Quality System

OpenWiki quality should be enforced at multiple layers. Prompts alone are not enough.

### Current Quality Gates

The current implementation validates:

- outline page count against repository size
- navigation references to generated page slugs
- outline source paths against the actual source inventory
- one generated page for every outline page
- minimum page word count by repository size
- markdown shape with title and multiple sections
- visible `Sources:` lines
- `## Relevant Source Files`
- structured citations
- required source paths present in the page when available
- no silent skips for failed page workers

This gives us a useful baseline, but the next quality layer should measure whether the docs are actually good, not merely non-empty.

### Docs-Site Quality Rubric

A generated wiki should be scored against a rubric:

- **Coverage:** the wiki covers the repository's actual public surface and important internal systems.
- **Specificity:** explanations name real files, functions, commands, configuration fields, routes, packages, examples, and tests when available.
- **Structure:** navigation feels like a documentation site, not a flat list of files.
- **Grounding:** concrete claims have visible source lines and structured citations.
- **Depth:** pages explain purpose, flow, edge cases, and usage, not just what files exist.
- **Accuracy:** cited paths exist at the indexed commit, and cited line ranges support the nearby claim.
- **Freshness:** wiki revision records the exact source commit and can be compared against repository changes.
- **Reader utility:** a new contributor or user can answer practical questions from the wiki without immediately diving into the repo.

### Proposed Quality Improvements

1. **Citation verifier**
   - Confirm every citation path exists in `source_files`.
   - Confirm line ranges are within file bounds.
   - Optionally sample cited snippets and check that surrounding prose is semantically related.

2. **Source coverage report**
   - Track which source files and directories are referenced by outline pages, page prose, and structured citations.
   - Highlight important unreferenced areas such as public exports, examples, docs, tests, and package entrypoints.

3. **Model reviewer pass**
   - Run a bounded reviewer after page generation.
   - Input: outline, page markdown, citations, source inventory summary, and quality rubric.
   - Output: pass/fail plus structured repair requests.
   - Only publish after deterministic validators and reviewer pass both succeed.

4. **Repo-type-aware page templates**
   - Libraries: API surface, usage examples, type definitions, edge cases, tests, release flow.
   - Frameworks: architecture, runtime, routing/data/cache, compiler/build, APIs, examples, deployment.
   - CLIs: commands, config, auth, environment, lifecycle, error handling, tests.
   - Monorepos: packages, shared infrastructure, build graph, integration contracts.

5. **Golden repository eval set**
   - Compact package: `vercel/ms`
   - Medium docs/source mix: `tailwindlabs/tailwindcss`
   - Large framework: `vercel/next.js`
   - Large systems repo: `rust-lang/rust`
   - Add private/internal repos once permissions are stable.

6. **Regression audit command**
   - Add a script that reads current wiki artifacts and reports page count, word count, headings, source lines, citations, missing pages, and stale commit state.
   - Run this locally after generator changes and in CI against fixture outputs.

7. **Generation trace artifacts**
   - Persist outline prompt inputs, selected snippets, validation failures, repair attempts, and final quality scores per job.
   - Keep traces separate from user-facing wiki content.

## Keeping Wikis Up To Date

OpenWiki needs both canonical updates for default branches and preview updates for pull requests.

### Canonical Default-Branch Updates

For every connected repository:

1. Install/configure a GitHub App or webhook.
2. Verify GitHub webhook signatures.
3. Handle `push` events for the configured default branch.
4. Compare the event `after` SHA with the current indexed revision.
5. Deduplicate jobs by repository and target SHA.
6. Start the same eve indexing channel with `targetSha`.
7. Publish only after all pages and artifacts pass quality gates.
8. Advance `repositories.current_indexed_revision_id`.
9. Revalidate `/`, `/repos/:owner/:repo`, and generated page paths.

The first production version can full-regenerate on every default-branch change. That is simpler and safer. Incremental generation can come next.

### Pull Request Preview Updates

PRs should not overwrite canonical docs.

For `pull_request` opened, reopened, synchronize, and ready-for-review events:

1. Create a PR-scoped preview record keyed by repository, PR number, and head SHA.
2. Start an index job for the PR head SHA.
3. Publish into preview pointers instead of `repositories.current_indexed_revision_id`.
4. Expose a preview route such as `/repos/:owner/:repo/pr/:number`.
5. Update a GitHub Check Run with queued, running, success, or failure status.

When a PR closes, mark the preview inactive. If it merges, the default-branch push should update canonical docs.

### Incremental Update Research

Full regeneration is the correct baseline, but large repositories need incremental behavior.

Research path:

1. Store page-to-source dependencies from outline source paths, visible `Sources:` lines, and structured citations.
2. On each commit, compute changed files.
3. Mark affected pages dirty when changed files intersect page dependencies.
4. Also mark overview/navigation pages dirty for broad changes.
5. Regenerate dirty pages against the existing outline when changes are local.
6. Regenerate the outline when repository shape changes, such as new packages, moved entrypoints, deleted docs, or changed public APIs.
7. Publish a new revision atomically after all dirty pages and reused pages are assembled into a complete wiki.

Open questions:

- How aggressive should dirty-page expansion be for shared files, generated types, package manifests, and config changes?
- What commit diff size should force a full reindex?
- How often should a scheduled full regeneration run to catch drift that incremental updates miss?

## Research Workstreams

### Workstream 1: Generation Traceability

Deliverables:

- Job-level trace record with commit SHA, file counts, selected source counts, outline size, page count, validation attempts, repair attempts, and publish revision.
- A local command to print a compact run summary.

Success criteria:

- A failed generation can be explained from stored traces without re-running the job.
- We can answer why a page exists and which source files caused it to be generated.

### Workstream 2: Source Selection And Coverage

Deliverables:

- Repository classifier for compact library, app, framework, CLI, monorepo, docs-heavy repo, and systems repo.
- Source selection profiles per repo type.
- Coverage report comparing inventory, selected snippets, outline source paths, and final citations.

Success criteria:

- Large repos receive broad subsystem coverage.
- Compact repos stay focused and do not produce fake docs depth.
- Public entrypoints, examples, tests, and docs are represented when present.

### Workstream 3: Outline And Navigation Quality

Deliverables:

- Page taxonomy rules by repo type.
- Outline reviewer or deterministic outline score.
- Navigation shape checks for depth, duplicate titles, missing overview, orphan pages, and source-backed pages.

Success criteria:

- Generated sidebars look like intentional documentation structures.
- The outline does not create pages without source evidence.
- Every generated page has a clear reader job.

### Workstream 4: Page Quality And Citation Validity

Deliverables:

- Citation verifier.
- Reviewer pass.
- Page repair loop that accepts structured reviewer feedback.
- Docs-site quality score per page and per wiki.

Success criteria:

- No published page has hallucinated source paths.
- Pages explain behavior, APIs, examples, and edge cases when supported by evidence.
- Failed or thin pages block publish and preserve the previous revision.

### Workstream 5: Freshness And Auto Update

Deliverables:

- GitHub webhook ingestion route.
- `targetSha` support in indexing.
- Default-branch push indexing.
- PR preview revisions.
- GitHub Check Run feedback.
- Deduplication and per-repository concurrency limits.

Success criteria:

- A default-branch push can update the canonical wiki without manual action.
- A PR can produce an isolated preview wiki without replacing canonical docs.
- Rapid push storms collapse to the latest relevant commit.

### Workstream 6: Evaluation Harness

Deliverables:

- Golden repository set with expected page-count ranges and coverage expectations.
- Snapshot artifacts for generated outlines and pages.
- Automated audit command for generated wikis.
- Browser smoke test for generated wiki pages after publish and revalidation.

Success criteria:

- Generator changes can be tested before shipping.
- The harness catches thin pages, missing pages, stale revalidation, and broken rendered docs.
- Quality regressions are visible as scores or diffable artifacts.

## Proposed Milestones

### Milestone 1: Baseline Reliability

- Keep current fail-fast page generation.
- Add citation verifier.
- Add audit script.
- Persist generation trace summaries.
- Run the golden repo set locally after generator changes.

### Milestone 2: Docs-Site Quality

- Add repo-type classifier.
- Improve outline taxonomy by repo type.
- Add reviewer pass and repair loop.
- Add source coverage reporting.
- Show page generation status and validation failures in the UI.

### Milestone 3: Canonical Auto Update

- Add GitHub webhook signature verification and delivery records.
- Add `targetSha` to indexing.
- Add default-branch push jobs.
- Deduplicate by repository and SHA.
- Publish and revalidate through the existing wiki revision path.

### Milestone 4: PR Preview Wikis

- Add preview revision storage.
- Add preview routes.
- Generate PR-scoped wikis.
- Add GitHub Check Run updates.
- Expire closed PR previews.

### Milestone 5: Incremental Regeneration

- Store page-to-source dependency maps.
- Detect dirty pages from commit diffs.
- Reuse clean pages across revisions.
- Trigger full outline regeneration when repository shape changes.
- Schedule periodic full reindexes as a safety net.

## Acceptance Criteria

A generated wiki is publishable only when:

- every outline page has a generated page
- every generated page passes deterministic markdown checks
- every page meets the repository-size word-count floor
- every page has visible source grounding and structured citations
- every citation path exists at the indexed commit
- navigation references only published pages
- current revision pointers advance only after all artifacts are written
- revalidation succeeds or logs a clear recoverable failure

An auto-update system is production-ready only when:

- GitHub webhook signatures are verified
- indexing targets an exact commit SHA
- duplicate events do not create duplicate work
- canonical and PR preview revisions are separated
- failed updates preserve the previous good wiki
- users can see job status and failure reasons
- generated docs can be audited after publish

