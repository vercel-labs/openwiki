# eve DX Feedback Deep Dive

## Summary

eve has the right architectural instincts for production agents: separate platform channels from harness behavior, keep runtime and workflow primitives in the runtime layer, and make agent execution durable enough to survive real product flows. That architecture was useful while building OpenWiki because the app is not a simple chat interface. It has repository ingestion, indexing jobs, outline generation, page worker fan-out, publication, manual reindexing, wiki page rendering, and repo chat.

The rough edge is that eve currently exposes too many runtime details to the app author. The strongest parts of eve are the same parts that made the implementation harder: channels, sessions, workflow handles, event streams, continuation tokens, durable jobs, and background execution are all powerful concepts, but the happy path still requires the product code to stitch them together manually.

Compared with [Flue](https://flueframework.com/), eve feels more rigorous and Vercel-native, while Flue feels easier to explain as a programmable harness. Flue's landing-page examples center the authoring model around `init()`, `session.skill()`, `session.prompt()`, and `session.shell()`. That makes the framework immediately legible: an agent is a model plus a harness plus a sandbox. eve has a deeper runtime story, but its public authoring story is less direct.

The product opportunity is to keep eve's stronger runtime model while adding a simpler harness-level API for common production workflows.

## OpenWiki As A Stress Test

OpenWiki exercised eve in ways that go beyond a basic request-response agent.

The indexing flow needs to:

- Accept a GitHub repository URL from the web app.
- Verify and upsert the repository.
- Reserve one active indexing slot per repository.
- Start a background eve run without blocking the UI.
- Fetch and hydrate a large repository snapshot.
- Select source evidence and context snippets.
- Generate an outline.
- Validate outline quality.
- Fan out page generation work.
- Parse, validate, and repair structured JSON outputs.
- Publish a wiki revision.
- Expose progress to the UI.
- Recover from stale or failed runs.

This is exactly the kind of real agent workflow eve should be great at. The experience proved that the architecture can support it, but also exposed the missing product affordances around job lifecycle, observability, payload safety, and structured output.

## What Felt Strong

### Channel Boundaries

The route/channel model made it natural to define internal endpoints such as an indexing endpoint and a repo chat endpoint. It was useful that the web app could treat the eve server as a separate agent service instead of merging all agent behavior into Next.js route handlers.

This shape maps well to production apps where platform-specific request handling should stay separate from harness logic.

### Vercel OIDC Auth

OIDC authentication fit the deployment model. Once wired, it provided a clean way for the web app to call internal eve routes without inventing a separate shared secret flow.

The auth model was one of the more polished parts of the experience because it felt like framework-owned platform integration rather than app-owned ceremony.

### Durable Runtime Shape

eve's channel, harness, and runtime split makes sense for serious agents. The distinction matters:

- Channels normalize platform input and own delivery behavior.
- Harnesses perform one unit of agent work.
- Runtime owns persistence, streaming, workflow wrapping, and continuation.

That design is more production-oriented than many AI SDKs that expose model calls but leave lifecycle, durability, and platform integration almost entirely to the app.

### Works For Real Product Flows

OpenWiki's indexing workflow did eventually work as a real asynchronous product flow. It can kick off indexing, track phases, publish results, reindex manually, and recover from some stale jobs.

That is a strong signal that eve has the right primitives underneath. The pain was not that the model was impossible. The pain was how much application code was needed to make the model reliable.

## Major Friction Areas

### Async Job Lifecycle

The biggest DX gap was async job lifecycle management.

In OpenWiki, we had to build:

- `index_jobs` database rows.
- Active job reservation per repository.
- Repository-level `active_index_job_id`.
- Phase transitions such as `fetching-repository`, `reading-context`, `outlining-wiki`, `generating-pages`, and `publishing`.
- Manual `ashSessionId` attachment.
- Failed job transitions.
- Stale pre-session job recovery.
- Stale active job recovery.
- Polling endpoints for the UI.

These are not OpenWiki-specific concerns. Every production agent app with long-running work will need some version of this.

eve should make this a first-class path. The app should be able to say: start this job, return immediately, persist status, expose a heartbeat, mark completion or failure, and give me a typed handle.

Suggested API shape:

```ts
const job = await ctx.jobs.start({
  name: "index-repository",
  input: { repositoryId, repoUrl },
  run: indexRepository,
});

return Response.json(job.accepted(), { status: 202 });
```

The returned handle should include stable identifiers:

- `job.id`
- `job.sessionId` once available
- `job.status`
- `job.phase`
- `job.createdAt`
- `job.updatedAt`

The framework should own the status record or provide a clearly documented adapter interface for storing it.

### Request Accepted Versus Job Running

The UI exposed an important semantic distinction: starting a reindex should be fast, but indexing may run for minutes.

We had to separately model:

- The POST request is in flight.
- The background job has been accepted.
- The background job is running.
- The background job is stuck or stale.
- The background job completed and the wiki should refresh.

The app initially blurred these states, which made the reindex button appear to load for the whole background job. That was an app bug, but it came from a framework gap: eve examples and primitives should make this distinction hard to miss.

The desired pattern is:

```txt
User clicks reindex
  -> API reserves job
  -> API starts eve work in background
  -> API returns 202 immediately
  -> UI stops request spinner
  -> UI shows job phase separately
```

eve should provide this pattern directly in examples and docs.

### Payload Size And Serialization Safety

The most painful failure was a large-payload issue where a workflow payload hit a 1 MiB boundary and surfaced as truncated JSON:

```txt
SyntaxError: Unterminated string in JSON at position 1048576
```

That error is technically accurate, but it points the app author in the wrong direction. The real issue was not malformed business JSON. It was a framework/runtime serialization boundary.

For large repo indexing, it is easy to accidentally put too much context into a worker state object. eve should catch this before enqueueing or resuming work.

Better errors would look like:

```txt
AshPayloadSizeError: workflow message payload is 1.3 MB, which exceeds the 1 MB local queue limit.

Move large data into durable storage and pass a manifest path or resource handle instead.
Largest fields:
- fileInventory: 780 KB
- contextSnippets: 420 KB
- skippedFiles: 80 KB
```

The framework should also document recommended patterns:

- Pass manifest paths instead of large arrays.
- Store file inventories outside workflow messages.
- Keep adapter state minimal.
- Treat context snippets as external resources when they can grow.

### Session Identity Plumbing

`ashSessionId` is important for debugging and UI linking, but OpenWiki had to thread it manually.

The indexing route had to:

- Start an eve run.
- Wait for a session handle.
- Attach that session ID to the index job.
- Handle failures before the session ID existed.
- Recover jobs that never got a session ID.

That distinction became an app-level reliability concern. Jobs could fail before an eve session was attached, leaving the UI in a running state unless we added custom stale-job cleanup.

eve should make session identity part of the job start contract. If a run can fail before a session exists, that failure should be represented in the same job record.

### Observability

Local debugging relied on:

- Terminal logs.
- Custom `logIndexing()` events.
- Database rows.
- API polling.
- Manual interpretation of phases.

This worked, but it was slow. A local eve runs dashboard would have helped a lot.

Useful views:

- All runs by status.
- Current phase.
- Session ID.
- Continuation token.
- Last event.
- Last heartbeat.
- Last error with cause chain.
- Payload size.
- Worker input summary.
- Event stream timeline.
- Links from app job IDs to eve sessions.

The key issue is not just "more logs." It is correlation. eve should make it easy to answer:

- Did the request reach the eve route?
- Did `waitUntil` register?
- Did the background task start?
- Did the session start?
- Is the model currently running?
- Is the worker parked?
- Did it fail before or after session creation?
- What was the last durable boundary?

### Structured Output

OpenWiki uses model-generated JSON for outlines and page drafts. The current implementation had to manually:

- Prompt for strict JSON.
- Parse the output.
- Validate it.
- Generate repair feedback.
- Retry with previous bad drafts.
- Enforce quality rules after parsing.

This pattern will be common. Agent workflows often need structured output, not just chat text.

eve should provide a worker helper for structured outputs:

```ts
const outline = await ctx.generateObject({
  schema: outlineSchema,
  prompt,
  repair: {
    attempts: 2,
    includeValidationErrors: true,
  },
});
```

It should also expose hooks for deterministic quality validation:

```ts
const outline = await ctx.generateObject({
  schema: outlineSchema,
  prompt,
  validate: getOutlineQualityIssues,
  repairAttempts: 2,
});
```

The framework does not need to own every quality rule, but it can own the loop mechanics.

### Fan-Out Workflows

OpenWiki needs outline generation followed by multiple page generation workers. This is a natural agent workload:

```txt
Generate outline
  -> for each page, generate page draft
  -> validate page
  -> retry failed pages
  -> publish all pages together
```

Today, the app owns most of the fan-out mechanics. The framework could provide patterns for:

- Batching.
- Concurrency limits.
- Per-item retries.
- Partial progress.
- Final aggregation.
- Cancellation.
- Resume after deployment.

This is an area where eve can be more than an agent SDK. It can become the orchestration layer for durable AI work.

## Comparison With Flue

Flue's positioning is clear: "Agent = Model + Harness." The examples on [flueframework.com](https://flueframework.com/) show agents that call skills, prompt sessions, run shell commands, and mount sandboxes. The code examples are compact and easy to read.

The strongest Flue DX signal is that the programmable harness is front and center:

```ts
const agent = await init({ model });
const session = await agent.session();
const result = await session.skill("triage", { args, result });
const comment = await session.prompt("Write a GitHub comment.");
await session.shell("gh issue comment ...");
```

That API tells a story quickly:

- Initialize an agent.
- Open a session.
- Give it capabilities.
- Ask it to do work.
- Keep sensitive environment details outside the model when needed.

eve's equivalent story is more implicit. The architecture is there, but the app author often meets it through route definitions, adapters, channels, `ctx.waitUntil`, event streams, workflow handles, and custom state.

That makes eve feel powerful but lower-level.

## Where eve Can Win

eve can differentiate from Flue if it leans into durable, Vercel-native production behavior while smoothing the authoring surface.

Potential strengths:

- Vercel deployment integration.
- OIDC auth by default.
- Durable workflow semantics.
- Channel-specific delivery policies.
- Runtime-owned persistence and event streaming.
- Strong separation between platform input, harness logic, and runtime execution.
- Built-in inspection of production runs.

The problem is not the architecture. The problem is discoverability and ceremony. eve needs a "simple thing is simple" layer above the architecture.

## Proposed Product Layers

### Layer 1: Harness API

This is the author-facing API for most users.

It should feel like:

```ts
export default defineAgent(async ({ session, input }) => {
  const repo = await session.skill("read-repository", { input });
  const outline = await session.structured("generate-outline", {
    schema: outlineSchema,
    input: repo,
  });
  return outline;
});
```

This layer should hide channel, workflow, and event stream details unless the author opts into them.

### Layer 2: Job API

This is for long-running work.

```ts
const job = await jobs.start("index-repository", {
  input: { repoUrl },
  run: indexRepository,
});
```

The framework should provide:

- Job ID.
- Session ID.
- Status endpoint.
- Heartbeat.
- Stale recovery.
- Cancellation.
- Restart.
- Result lookup.

### Layer 3: Runtime API

This remains available for advanced users.

It includes:

- Channels.
- Continuation tokens.
- Event streams.
- Runtime storage.
- Delivery policy.
- Workflow primitives.

This is the layer eve already feels oriented around. It should stay powerful, but it should not be the first thing every app author has to learn.

## Documentation Recommendations

eve docs should include end-to-end recipes for real product flows.

High-value guides:

- Build a long-running indexing job.
- Start work asynchronously and return `202`.
- Show background progress in a web UI.
- Attach a run/session ID to product state.
- Recover stale jobs.
- Fan out workers with concurrency limits.
- Generate structured output with validation and repair.
- Keep payloads small for large repositories.
- Debug a parked or failed local run.

Each guide should include:

- The happy path.
- Failure modes.
- What the framework owns.
- What the app owns.
- How to inspect the run locally.
- How to inspect the run in production.

## API Recommendations

### Async Work

Add a first-class async work primitive:

```ts
const run = await ctx.runs.start({
  name: "index-repository",
  input,
  wait: false,
});
```

Return:

```ts
{
  id: string;
  sessionId?: string;
  status: "accepted" | "running" | "completed" | "failed" | "stale";
  statusUrl: string;
}
```

### Phases

Make phase updates framework-visible:

```ts
await ctx.phase("reading-context");
await ctx.phase("outlining-wiki");
await ctx.phase("generating-pages", { current: 3, total: 36 });
```

### Heartbeats

Long-running jobs should heartbeat automatically around model calls and workflow steps. Apps should not need to infer staleness only from `startedAt`.

### Structured Output

Provide a schema-first structured generation primitive with repair:

```ts
await ctx.output.object({
  schema,
  prompt,
  repairAttempts: 2,
});
```

### Payload Diagnostics

Add payload inspection:

```ts
await ctx.assertPayloadBudget({ maxBytes: "1mb" });
```

or automatic diagnostics whenever a run is started.

## Concrete OpenWiki Issues eve Could Have Prevented

### Silent Large Payload Failure

eve could have caught the large worker payload before enqueueing and suggested moving inventory/context into a manifest.

### Jobs Stuck Before Session Attachment

eve could have represented "accepted but no session yet" as a first-class state and automatically failed or retried after a startup timeout.

### Jobs Stuck After Session Attachment

eve could have provided heartbeats and stale detection instead of requiring app-level active job timeout logic.

### Reindex UI Confusion

Framework examples could clearly separate request startup state from background job progress state.

### Manual JSON Repair Loops

eve could have owned the schema parse, validation feedback, and retry loop.

## Final Take

eve feels like a promising production runtime that currently lacks a polished harness authoring layer. Flue feels like it starts with the harness layer and makes the agent programming model obvious. eve starts with stronger durability and platform boundaries, but asks the app author to understand those boundaries earlier.

The best version of eve would combine both:

- Flue-like simplicity for authoring agent behavior.
- eve's durable, Vercel-native runtime underneath.
- First-class async job lifecycle.
- Built-in observability.
- Safe payload handling.
- Structured output as a standard path.

If eve can make long-running production agent workflows feel as simple to author as a harness script, while preserving its runtime rigor, it will be much easier to adopt and much harder to outgrow.
