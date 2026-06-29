# AI SDK Quality Runs

## Goal

Bring OpenWiki output for `vercel/ai` closer to the first-party AI SDK docs quality without hardcoding AI SDK-specific pages.

Reference docs sampled:

- https://ai-sdk.dev/
- https://ai-sdk.dev/docs/introduction
- https://ai-sdk.dev/docs/foundations/overview
- https://ai-sdk.dev/docs/agents/overview
- https://ai-sdk.dev/docs/agents/building-agents
- https://ai-sdk.dev/docs/foundations/streaming
- https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text

## Quality Rubric

Score each run from 1-5 against these dimensions:

- Information architecture: sidebar has a learning path, conceptual docs, usage guides, advanced topics, examples/cookbook, troubleshooting, and reference material when source evidence supports them.
- Reader progression: pages move from "what/why" to setup, core concepts, implementation patterns, edge cases, and next steps.
- Source grounding: claims cite concrete source paths and source files are explained for their role, not just listed.
- API usefulness: public entry points, functions, classes, hooks, transports, providers, and configuration surfaces are covered at the right level of detail.
- Example quality: pages include source-backed examples or workflows that teach realistic usage.
- Troubleshooting and operations: docs explain failure modes, compatibility boundaries, testing, telemetry, deployment, or migration when the repo contains evidence.
- Reference separation: reference pages are precise and structured, while guide pages remain task-oriented.

## Baseline Observations

### Run 0: pre-quality-pass local state

- URL: `http://localhost:3000/repos/vercel/ai`
- Status: no published wiki yet; page shows "Starting wiki generation..."
- Previous failure mode: worker startup payload exceeded/truncated around 1 MiB before `ash_session_id` attached.
- Recent robustness fix: worker adapter state no longer carries the full inventory/context payload, startup failures are propagated to `index_jobs`, and repo-level active job reservation prevents duplicate jobs.

### AI SDK docs shape to emulate generically

- Landing page states product value, key capabilities, code-first proof, ecosystem integrations, and starter paths.
- Introduction page splits "why", main libraries, providers, templates, and navigation.
- Foundation pages define concepts in approachable language and point to next concepts.
- Agent pages provide "why use this", configuration sections, code examples, usage patterns, type safety, and next steps.
- Reference pages like `streamText` are exhaustive, parameter-oriented, and distinct from guide pages.

## Changes Tried

### Pass 1: first-party-docs prompt and evidence selection

Approach:

- Add generic first-party documentation expectations to outline and page prompts.
- Promote learning-path sections and reference separation for public SDK/library repos.
- Improve generic context ranking so package READMEs, package metadata, docs, examples, cookbook/templates, and public entrypoints are selected ahead of incidental source files.

Expected result:

- `vercel/ai` outline should include AI SDK-like sections such as Getting Started, Foundations/Core Concepts, Core APIs, UI/integration docs, Agents/workflows, providers/model management, examples/cookbook, advanced operations, troubleshooting/testing, and reference, if supported by source evidence.
- Pages should be more task-oriented and include examples/next steps instead of only architecture summaries.

Observed:

- Job `f2889a3b-74be-4636-9a7f-1e1d214945d6` produced a 36-page outline, but the deterministic quality gate rejected it because it had fewer than four top-level navigation folders.
- That rejection was too structural and not directly tied to documentation quality. A high-quality wiki can have fewer top-level folders if it still has a good reader journey and enough focused pages.

### Pass 2: remove product-comparison language and loosen brittle validation

Approach:

- Remove references to DeepWiki from active system prompts and use OpenWiki-owned quality language instead.
- Keep source-grounded first-party documentation expectations.
- Remove the top-level navigation folder count as a hard failure. Keep reader-journey validation for overview, getting started, concepts, guides/examples, and API/reference coverage.

Active run:

- Job `d9791751-b33c-4e6d-a70e-a94f0a065918`
- Status: completed and published revision `0782455c-61ef-4244-acb6-832de1a123a6`
- Output: 20 pages across Getting Started, Core Concepts, Providers & Packages, SDK Usage & Recipes, Developer Workflows, Migration & Codemods, and Contributing & Maintainers.

Quality notes:

- Information architecture improved from no published wiki to a multi-section developer docs tree with setup, concepts, providers, usage, examples, testing, codemods, and contributing coverage.
- Source grounding improved: generated pages include visible source paths and `Sources:` lines.
- Remaining gap: the outline still skews toward provider/package inventory. To approach first-party SDK docs, the next pass should generically prioritize public API reference surfaces such as generation functions, chat hooks, streaming, agents, tools, structured output, transports, and provider configuration when these are visible in source.
- Remaining gap: guide pages need stronger code-first task flows and less monorepo-oriented phrasing.

### Pass 3: generic public-surface discovery and catalog balance

Approach:

- Add a generated "Public surface candidates" prompt section derived from generic path conventions: root/package READMEs, package metadata, top-level entrypoints, CLI/command modules, route/API modules, configuration/types/schema files, docs, examples, cookbook, and templates.
- Strengthen outline guidance to prioritize the reader-facing public contract over implementation inventory.
- Add a generic outline quality check that rejects large outlines dominated by implementation catalog pages when they lack enough guide, reference, examples, troubleshooting, or configuration coverage.

Expected result:

- Large SDKs, libraries, CLIs, frameworks, services, and plugin ecosystems should still document their implementation families, but similar adapters/providers/plugins/packages should be grouped unless individual pages are clearly warranted.
- The sidebar should reserve space for public API/reference surfaces and task-oriented guides discovered from the repository evidence, without naming or hardcoding any specific repository.

Validation run:

- Job `4b31ae34-277d-4ea4-ad4c-e9dbe7667d9d`
- Status: completed and published revision `a7ba052c-752c-4d33-b352-6f747e21fd2e`.
- Output: 36 pages across Getting Started, Core Concepts, Providers & Adapters, API Reference & Recipes, Framework Recipes, Guides & Advanced Usage, Examples & Cookbook, and Testing & Migration.
- Quality improved materially from Pass 2: the outline now includes public API surfaces such as generating text, structured data, image generation, speech/transcription, embeddings/reranking, tool calling, streaming, framework recipes, gateway, telemetry, auth/configuration, migration, and testing.
- Remaining gap against the real AI SDK docs: the actual site separates Foundations, Getting Started, Agents, AI SDK Core, AI SDK UI, RSC, Advanced, Reference, Migration, and Troubleshooting with many compact reference leaves. OpenWiki now approximates the shape, but it still compresses some product-docs categories and has fewer reference leaves than a hand-authored docs site.

### Pass 4: docs-source-first IA for repositories with first-party docs

Approach:

- Compare generated output against the actual AI SDK and Next.js docs sites, not just the repository tree.
- The AI SDK docs show a product-docs spine: introduction, foundations, getting started, agents, core, UI, RSC, advanced, exhaustive reference, migration, and troubleshooting.
- The Next.js docs show an even clearer docs-site spine: Getting Started, Guides, API Reference, Glossary, Architecture, Community, plus App Router and Pages Router separation.
- Add a generated "Documentation source candidates" prompt section derived from generic docs paths: `docs`, `content/docs`, `site/docs`, `website/docs`, READMEs, `llms.txt`, sitemap files, metadata/navigation files, and markdown docs.
- In prompts and validation, tell the generator that substantial first-party docs source should drive the reader-facing information architecture. Implementation source should deepen and verify docs pages rather than turning the wiki into repository archaeology.

Expected result:

- Docs-rich repositories should generate product/user documentation first and contributor or repository-maintenance documentation second.
- Large framework repos should avoid leading with "repository overview", "monorepo management", or "build/release infrastructure" when the source contains enough user-facing tutorials, guides, API reference, migration, troubleshooting, examples, and glossary docs.
- This should improve both AI SDK-like SDK repos and Next.js-like framework repos without hardcoding either product or repository name.

Validation runs:

- AI SDK job `a49ef02d-d0b4-4887-91d0-f150fe95969f`: outline passed validation with 36 pages and page generation is running.
- Next.js job `94278e69-0906-4695-a080-9702e2d0a0a9`: fresh reindex started after clearing a stale active job; currently running in outline generation.
- Operational note: local page worker concurrency was not reaching package dev processes through Turbo, so `OPENWIKI_PAGE_WORKER_CONCURRENCY`, `OPENWIKI_PRE_SESSION_STALE_MS`, and `OPENWIKI_ACTIVE_JOB_STALE_MS` were added to the `dev` task env allowlist for future runs.

### Pass 5: rendered-page audit and stricter docs-quality gates

Approach:

- Compare rendered OpenWiki output against official docs-site shapes for representative projects: Next.js docs, Tailwind CSS docs, Rust documentation, and VS Code docs/API docs.
- Add a reusable rendered-page audit command that crawls current wiki pages through the app route and reports render errors, thin pages, missing source lines, sparse headings, and low example/reference detail.
- Add a generated "First-party docs information architecture hints" section that groups docs source paths into a compact source-derived sidebar spine before outline generation.
- Raise the minimum outline depth for docs-rich repositories so projects with substantial first-party docs do not collapse into a shallow 6-8 page wiki.
- Strengthen page validation for API/reference/configuration/command pages so they need concrete names, signatures, options, routes, commands, exported types, or tables when source evidence supports it.
- Strengthen guide-like pages so getting started, workflow, example, migration, and troubleshooting pages include concrete commands, code/config fragments, steps, or examples when source evidence supports it.
- Reject page prose that says a cited file was "not directly included" or otherwise apologizes about missing evidence; that belongs in `coverageNotes`, not user-facing docs.

Expected result:

- Docs-rich repos should better match real documentation site information architecture without hardcoding repository-specific pages.
- Page content should become less generic and more useful for practical docs-reading tasks: install, configure, call APIs, follow workflows, troubleshoot, and map claims back to source.
- The audit command should make quality regression loops repeatable after prompt or validator changes.
