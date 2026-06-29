# eve DX Feedback

## Context

This feedback comes from building OpenWiki on eve: a repository search, indexing, wiki generation, and repo chat app that uses eve routes, background indexing workers, Vercel OIDC auth, and long-running agent jobs.

The comparison point is [Flue](https://flueframework.com/), which presents itself as a programmable agent harness with a direct `init()`, `session.skill()`, `session.prompt()`, and `session.shell()` API that can run as HTTP endpoints, CLI tasks, or CI jobs.

## What Worked Well

- The channel and route model made internal agent endpoints feel natural.
- Vercel OIDC auth integration was straightforward and fit the deployment model.
- `ctx.waitUntil()` gave us the basic shape for async indexing work.
- The channel, harness, and runtime split is a strong foundation for production agents rather than chat-only workflows.
- eve made it possible to model a real product flow: repo ingestion, outline generation, page generation, publication, and chat.

## Friction

- Large payload failures were too silent. A workflow payload hit a 1 MiB boundary and surfaced as truncated JSON instead of an early framework error.
- Async job lifecycle required too much application-owned plumbing: active job reservation, phase updates, session attachment, stale job recovery, and polling.
- `ashSessionId` attachment had to be manually threaded through the indexing path. The framework should expose job and session identity at kickoff.
- Long-running job observability leaned on custom logs and database state. It was hard to quickly answer whether a job was running, parked, failed, or stale.
- Structured output required manual parse, validate, retry, and repair loops.
- The UI had to paper over runtime behavior. For example, reindexing kicked off asynchronously, but the app had to separately manage "request is starting" versus "background job is running."

## Comparison With Flue

Flue's public API is easier to explain from the outside: initialize an agent, create a session, call skills, prompt, and run shell commands inside a chosen sandbox. That shape reads like the programmable harness behind coding agents.

eve feels more Vercel-native and more rigorous about runtime boundaries. It has a stronger systems architecture for durable agents, but the authoring surface currently exposes more internal machinery than an app developer should need to handle.

The opportunity for eve is to preserve the channel/harness/runtime rigor while offering a simpler harness-level API for common production patterns.

## Recommendations

- Add a first-class async job primitive that returns immediately with `{ jobId, sessionId }`.
- Provide built-in status transitions: accepted, started, heartbeat, failed, completed, stale.
- Add framework-level payload-size guards and clear serialization errors before enqueueing work.
- Make structured output and retry/repair loops a built-in worker primitive.
- Provide local dev observability for runs, worker phases, sessions, and background errors.
- Ship recipes for large repo indexing, fan-out page generation, manual reindexing, and status polling.
- Separate "request accepted" from "background work running" in framework examples so UI authors do not accidentally block on startup.

## Product Takeaway

eve has the stronger production systems shape. Flue has the simpler harness story. eve would feel much easier to adopt if the common path looked like a concise programmable harness API, with the durable runtime details available when needed rather than required up front.
