# OpenWiki

OpenWiki uses the eve framework. Before writing eve code, always read the
relevant guide in `node_modules/eve/docs/`.

## Principles

1. **Document plans before broad implementation.**
   Put active design notes in `docs/active/`. Move completed or superseded plans
   to `docs/completed/` so current intent stays easy to find.

2. **Capture harness gaps while they are fresh.**
   When unclear docs, missing examples, confusing errors, or repeated manual
   steps slow the work down, add a short entry to `docs/harness-gaps.md`.

## Development

- Use Node.js 24 or newer.
- Use `pnpm` for package management.
- Use root scripts (`pnpm dev`, `pnpm typecheck`, `pnpm build`) for app tasks.
- Keep generated files, local env files, and Vercel link state out of git.

## Verification

For code changes, run the tightest relevant check before declaring the work done:

- `pnpm typecheck` for TypeScript changes.
- `pnpm build` for routing, Next.js config, dependency, or eve integration changes.

Docs-only changes do not require typecheck unless they also change package
metadata or code.
