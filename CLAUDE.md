# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`omnideploy` is a TypeScript/Node (ESM, Node ≥ 20) CLI. It detects a project's language and framework, generates whatever deployment files are missing (Dockerfile, render.yaml, railway.json, vercel.json, netlify.toml), and deploys to Vercel, Netlify, GitHub Pages, Railway or Render. Users should be able to deploy any language with a single command.

## Commands

```bash
npm run build                 # tsup → dist/main.js (single ESM bundle with shebang)
npm run dev -- <args>         # run from source via tsx, e.g. npm run dev -- deploy --dry-run -C <dir>
npm run typecheck             # tsc --noEmit (vitest does NOT typecheck — always run this too)
npm run lint:arch             # dependency-cruiser: enforces the Clean Architecture layer rules
npm test                      # vitest run
npm run check                 # typecheck + lint:arch + test
npx vitest run tests/infrastructure/providers.test.ts      # one file
npx vitest run -t "Java → Render"                          # one test by name
npx vitest run -u             # update snapshots (Dockerfile templates are snapshot-tested)
npm run smoke:docker          # needs a running Docker daemon; builds+runs generated Dockerfiles for e2e/apps/*
scripts/docker-smoke.sh spring-boot   # one smoke app (run npm run build first)
```

## Architecture (Clean Architecture — enforced)

Dependencies point inward only. `.dependency-cruiser.cjs` fails if a layer imports from the wrong place:

- `src/domain`: entities (`ProjectProfile`, `ProjectConfig`, `Deployment`, `ProviderCapabilities`), **ports** (interfaces for fs, process, http, git, credentials, config, prompt, logger, plus `ProjectDetector`, `ArtifactGenerator`, `DeploymentProvider`), pure services (`checkCompatibility`, `isSinglePageApp`, `toServiceName`), and the typed `DomainError` hierarchy. **No Node APIs and no third-party imports.**
- `src/application`: use cases that orchestrate ports. May import only from `domain`. The core flow is `DeployProject`: detect → compatibility check (fail fast) → `GenerateArtifacts` → credentials (`CredentialResolver`: env var → store → prompt) → `provider.validate` → git sync for `buildsFromGit` providers (commit and push generated files) → `BuildProject` (static sites only; server apps are built remotely) → `provider.deploy` for each target → persist `deployment.configUpdates` into omnideploy.json.
- `src/infrastructure`: adapters that implement the ports. It must not import from `cli`.
  - `detectors/`: one `ProjectDetector` per ecosystem. `DetectProject` keeps the highest `confidence` (language detectors score ~80–90, `StaticDetector` 40, `DockerDetector` 20, so a Dockerfile-only project still deploys). Language-specific values that generators need go in `profile.meta`.
  - `generators/`: `dockerfile/templates.ts` holds one template function per language. Each must stay multi-stage, pinned, non-root, and listen on `$PORT`; tests assert this. `provider-config/` holds render/railway/vercel/netlify configs.
  - `providers/`: each `DeploymentProvider` declares `capabilities` (which drive compatibility), `requiredArtifacts(profile)` (artifact ids matched to generators by `id`), `validate`, `deploy` and optionally `status`.
- `src/cli`: commander commands plus clack presenters. `container.ts` is the **only composition root**; it's where concrete adapters are wired into use cases.

### How artifacts link to providers
`provider.requiredArtifacts(profile)` returns ids such as `'dockerfile'`. `GenerateArtifacts.plan` finds a generator with the same `id` whose `supports(profile)` is true, de-dupes artifacts shared between providers, and marks each one `create`, `overwrite` (only with `--force`) or `keep` (the file already exists). If an artifact has no generator and no existing file, it throws `NO_GENERATOR`.

### Extending
- New provider, detector or generator: write one class implementing the port and add it to `builtInProviders` / `builtInDetectors` / `builtInGenerators` in that folder's `index.ts`. `domain` and `application` should not need changes.
- Render's decision between native and Docker is shared: `renderUsesDocker()` in `generators/provider-config/render.ts` is used by both the generator and `RenderProvider`.
- Update `schema.json` when you add `omnideploy.json` fields. The zod schema in `JsonConfigRepository` must match it.

## Conventions and gotchas

- User-facing failures must be `DomainError` subclasses with a `hint`. The CLI prints `message` and `Try: hint`, and shows stacks only with `--debug`. Don't start hints with "Try:", because the presenter already adds it.
- Never let tokens reach output: use `redact()` (`providers/support.ts`) on any CLI or git output that might contain one. Tests check this.
- `FetchHttpClient` resolves `globalThis.fetch` on each request (not at construction) so msw can intercept it. It retries 408/425/429/5xx and maps 401/403/404/429 to hints.
- Tests: application tests use the in-memory fakes in `tests/helpers/fakes.ts` (no I/O). Provider tests use msw v3; its option is `server.listen({ onUnhandledFrame: 'error' })`. The old `onUnhandledRequest` name is silently ignored and lets requests reach the real network. Pass fast `PollOptions` to providers in tests.
- Detector tests run against the sample projects in `tests/fixtures/<name>`. The Docker smoke apps in `e2e/apps/<name>` are real, runnable apps that respond with `omnideploy smoke: <name>`.
- TypeScript is pinned to ^6 because dependency-cruiser doesn't support TS 7 yet.
- Interactivity: `--no-interactive`, `CI`, or a non-TTY stdin all disable prompts. Use cases must then either proceed (with `--yes`) or throw a `DomainError` that explains how to proceed. They must never hang.
