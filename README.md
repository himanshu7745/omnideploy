# omnideploy

One CLI to deploy any project — Node, Python, Java, Go, Rust, Ruby, PHP, .NET or plain HTML — to **Vercel, Netlify, GitHub Pages, Railway and Render**.

```bash
cd my-spring-boot-app
npx omnideploy deploy render
```

omnideploy works out what your project is, writes the deployment files the platform needs (a multi-stage `Dockerfile`, `render.yaml`, `railway.json`, `netlify.toml`, `vercel.json`), shows you what it will write, and deploys.

```
◆  Detected Java 21 · spring-boot · server · port 8080
◇  Deployment files to generate
│  + Dockerfile     — multi-stage Java (spring-boot) image (for render)
│  + .dockerignore  — keeps the Docker build context small (for render)
│  + render.yaml    — Render Blueprint (docker runtime) (for render)
◆  Pushed deployment files
◆  Render: https://demo-api.onrender.com
```

## Install

```bash
npm install -g omnideploy     # or use npx omnideploy …
```

Requires Node.js 20+. Railway deployments also need the [Railway CLI](https://docs.railway.com/guides/cli).

## Quick start

```bash
omnideploy init                  # detect, choose providers, generate files, write omnideploy.json
omnideploy login netlify         # paste a token (or set NETLIFY_AUTH_TOKEN)
omnideploy deploy                # deploy to every provider in omnideploy.json
omnideploy deploy vercel netlify # or name them
```

## Commands

| Command | What it does |
|---|---|
| `init` | Detects the project, offers only compatible providers, previews and writes deployment files and `omnideploy.json`. |
| `deploy [providers...]` | Checks compatibility → generates missing files → checks credentials → builds → deploys → prints URLs. Flags: `--preview`, `--no-build`, `--dir <path>`, `--dry-run`, `--yes`, `--force`. |
| `generate <providers...>` (alias `eject`) | Only writes the deployment files, for deploying some other way. |
| `login <provider>` / `logout <provider>` | Save or remove a provider token (`--token` for scripts). |
| `providers` (alias `ls`) | Login state, required CLIs, and which providers fit this project. |
| `doctor` | Checks Node, git remote, config, tokens and tools, with a fix for each problem. |
| `status <provider> [id]` | Latest (or a specific) deployment's state and URL. |

Global flags: `-C, --cwd <dir>`, `--debug`, `--no-interactive`.

## What runs where

| | Vercel | Netlify | GitHub Pages | Railway | Render |
|---|:-:|:-:|:-:|:-:|:-:|
| Static sites (Vite, CRA, Angular, Astro, plain HTML…) | ✔ | ✔ | ✔ | ✔ (nginx image) | ✔ |
| Next.js / Nuxt / SvelteKit / Remix / Astro SSR | ✔ native | | | ✔ Docker | ✔ |
| Servers in any language | | | | ✔ Docker | ✔ native or Docker |

If you ask for something a provider can't host, omnideploy explains why and suggests one that can:

```
■  Vercel: only hosts static sites and nextjs, nuxt, sveltekit, remix or astro apps, not spring-boot servers
│  Try: Deploy to Railway or Render instead.
```

### Detected languages and frameworks

| Language | Detected from | Frameworks |
|---|---|---|
| Node.js | `package.json` | Next.js, Nuxt, SvelteKit, Remix, Astro, Gatsby, Angular, CRA, Vite, NestJS, Express, Fastify, Koa, Hono |
| Python | `requirements.txt`, `pyproject.toml`, `Pipfile`, `manage.py` | Django, FastAPI, Flask, Streamlit (pip, Poetry, uv) |
| Java | `pom.xml`, `build.gradle(.kts)` | Spring Boot, Quarkus, Micronaut (Maven, Gradle) |
| Go | `go.mod` | Gin, Echo, Fiber, chi, net/http (`cmd/*` layouts) |
| Rust | `Cargo.toml` | Axum, Actix Web, Rocket, Warp, Poem |
| Ruby | `Gemfile` | Rails, Sinatra |
| PHP | `composer.json`, `index.php` | Laravel, Symfony, plain PHP |
| .NET | `*.csproj` | ASP.NET Core |
| Static | `index.html` | — |
| Anything | `Dockerfile` | your own image |

Generated Dockerfiles are multi-stage, pin the detected runtime version, run as a non-root user and listen on `$PORT`. An existing `Dockerfile` (or any other existing file) is never overwritten unless you pass `--force`.

## Credentials

Tokens are looked up in this order: **environment variable → saved token → prompt**. Saved tokens live in `~/.config/omnideploy/credentials.json` (mode `0600`; override the directory with `OMNIDEPLOY_CONFIG_DIR`).

| Provider | Env var | Create a token |
|---|---|---|
| Vercel | `VERCEL_TOKEN` | https://vercel.com/account/tokens |
| Netlify | `NETLIFY_AUTH_TOKEN` | https://app.netlify.com/user/applications#personal-access-tokens |
| GitHub Pages | `GITHUB_TOKEN` | https://github.com/settings/tokens (`repo` scope) |
| Railway | `RAILWAY_TOKEN` | Project → Settings → Tokens (project token) |
| Render | `RENDER_API_KEY` | https://dashboard.render.com/u/settings#api-keys |

## omnideploy.json

Everything is optional. Values here override detection, and IDs created on the first deploy (Netlify site, Vercel project, Render service) are saved back so later deploys update the same app.

```json
{
  "$schema": "https://unpkg.com/omnideploy/schema.json",
  "name": "demo-api",
  "build": { "command": "npm run build", "output": "dist" },
  "app": { "start": "node server.js", "port": 3000, "healthCheckPath": "/health" },
  "providers": {
    "vercel": { "teamId": "team_123" },
    "netlify": { "siteId": "…" },
    "github-pages": { "branch": "gh-pages", "cname": "www.example.com" },
    "railway": { "service": "api", "environment": "production" },
    "render": { "plan": "starter", "region": "frankfurt" }
  }
}
```

## Provider notes

- **Render** builds from your git remote, so generated files have to be pushed. omnideploy offers to commit and push them, and warns about any other uncommitted changes, which won't be deployed. Private repos require connecting your Git provider in the Render dashboard.
- **GitHub Pages** publishes the build output to the `gh-pages` branch and enables Pages. For project sites served under `/<repo>/`, set your bundler's base path (for Vite, `base: '/<repo>/'`).
- **Railway** uses the official CLI (`railway up`), which uploads the project together with the generated `Dockerfile` and `railway.json`.
- **Netlify** and **Vercel** upload your local build output directly; SPA routes get a rewrite to `index.html`.

## CI

```yaml
- run: npx omnideploy deploy netlify --yes
  env:
    NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
```

`CI=true` or a non-TTY stdin turns off prompts. Without `--yes`, any step that needs confirmation fails with a clear message.

## Development

```bash
npm install
npm run dev -- deploy --dry-run -C ../some-project   # run from source
npm run check                                        # typecheck + architecture rules + tests
npm run smoke:docker                                 # build & run generated Dockerfiles (needs Docker)
```

The code follows Clean Architecture, and the dependency rule is enforced by `dependency-cruiser`:

```
src/domain          entities, ports (interfaces), compatibility policy — no I/O, no libraries
src/application     use cases (detect, generate, build, deploy, …) — depend only on domain
src/infrastructure  detectors, generators, providers, adapters (fs, http, git, process, config, credentials)
src/cli             commander commands, clack presenters, container.ts (composition root)
```

To add a provider, detector or file generator, implement the matching domain port (`DeploymentProvider`, `ProjectDetector`, `ArtifactGenerator`) in `src/infrastructure/…` and register it in that folder's `index.ts`. Nothing in `domain` or `application` changes.

## License

MIT
