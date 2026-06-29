# AGENTS.md

## Project Shape

OpenWiki is a single Next.js app with Eve embedded through `withEve`:

- `app/` is the Next.js UI and browser-facing API surface.
- `agent/` is the Eve agent runtime and OpenWiki-specific channels.
- `lib/` contains shared domain and storage helpers.
- The browser should call Next.js routes; server routes call embedded Eve routes under `/eve/v1/openwiki/*`.

## Principles

1. **Keep access boundaries explicit.**
   The MVP does not have app-level user auth; access is controlled by Vercel Deployment Protection. Internal calls to Eve use same-origin server-side fetches plus Vercel OIDC or `OPENWIKI_INTERNAL_SECRET`. Deployment Protection bypass headers are transport plumbing, not application authorization.

2. **Keep secrets server-side.**
   Do not expose `OPENWIKI_INTERNAL_SECRET`, `VERCEL_OIDC_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET`, AI Gateway credentials, or other secrets to client components.

3. **Use Eve channels for web-to-server work.**
   Next.js API routes should talk to OpenWiki-specific Eve routes under `/eve/v1/openwiki/*`. Do not reintroduce an ad hoc echo chat route in Next.js.

4. **Document plans before broad implementation.**
   Put active design notes in `docs/active/`. Move completed or superseded plans to `docs/completed/` so current intent stays easy to find.

5. **Capture harness gaps while they are fresh.**
   When unclear docs, missing examples, confusing errors, or repeated manual steps slow the work down, add a short entry to `docs/harness-gaps.md`.

## Development

- Use Node.js 24 or newer.
- Use `pnpm` for package management.
- Use root scripts (`pnpm dev`, `pnpm typecheck`, `pnpm build`) for app tasks.
- Keep generated files, local env files, and Vercel link state out of git.

## Verification

For code changes, run the tightest relevant check before declaring the work done:

- `pnpm typecheck` for TypeScript changes.
- `pnpm build` for routing, Next.js config, dependency, or Eve integration changes.

Docs-only changes do not require typecheck unless they also change package metadata or code.
