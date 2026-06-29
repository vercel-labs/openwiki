# Harness Gaps

This file captures moments where an agent or contributor needed extra guidance
that should become durable harness: a clearer doc, a lint, a test, a better
error message, or a more obvious file layout.

Write entries while the friction is fresh. The goal is not to blame the agent;
the goal is to improve the repository so the next run needs less correction.

## Entry Format

```md
## YYYY-MM-DD - Short Title

- Type: missing-doc | unclear-pattern | lint-gap | test-gap | confusing-error | other
- Task:
- Friction:
- Fix idea:
- Agent:
- Links:
```

## Open Items

## 2026-05-03 - Large Wiki Quality Runs Expose Fragile Inputs

- Type: test-gap
- Task: Regenerate compact, medium, and large repositories to improve wiki output quality.
- Friction: Local indexing hit anonymous GitHub API 403s, then large `vercel/next.js` runs failed late because one page worker returned citation line numbers as `0` and another returned invalid JSON escaping. These failures happened after several minutes of model work and forced full reruns.
- Fix idea: Keep GitHub API requests authenticated when `GITHUB_TOKEN` is available, tolerate non-positive citation line numbers by dropping them, and retry malformed page-worker JSON with strict repair feedback.
- Agent: Cursor
- Links: None

## 2026-05-03 - Indexing Quality Verification Friction

- Type: confusing-error
- Task: Improve generated wiki quality and verify a fresh local generation in the browser.
- Friction: A medium `vercel/swr` generation reached `generating-pages` but stayed there for several minutes with no progress detail about page count, batch size, or model output size. Restarting local dev afterward failed with `Expected the channel export "default" from "channels/.well-known/ash/v1/message.ts" to match the public eve shape.`, which did not identify the invalid field or expected shape.
- Fix idea: Log outline page count, page-generation batch boundaries, and per-subagent elapsed time. Improve eve channel validation errors to include the received definition kind and required fields.
- Agent: Cursor
- Links: None
