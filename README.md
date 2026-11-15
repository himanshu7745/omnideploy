# omnideploy

One CLI to deploy any project — Node, Python, Java, Go, Rust, Ruby, PHP, .NET or plain HTML — to **Vercel, Netlify, GitHub Pages, Railway and Render**.

```bash
cd my-spring-boot-app
npx omnideploy-cli deploy render
```

omnideploy works out what your project is, writes the deployment files the platform needs (a multi-stage `Dockerfile`, `render.yaml`, `railway.json`, `netlify.toml`, `vercel.json`), shows you what it will write, and deploys. For platforms that build from git, it also takes care of the repository: it creates one if you don't have one, and commits and pushes your changes on every redeploy. Production configuration lives in one place, `.env.production`, and is set on the platform for you.

```
◆  Detected Java 21 · spring-boot · server · port 8080
◇  Deployment files to generate
│  + Dockerfile     — multi-stage Java (spring-boot) image (for render)
│  + .dockerignore  — keeps the Docker build context small (for render)
│  + render.yaml    — Render Blueprint (docker runtime) (for render)
◆  Pushed to https://github.com/you/demo-api
◆  Render: https://demo-api.onrender.com
```

This README is the reference for everything omnideploy does. If something here doesn't match what the CLI does, that's a bug — please [open an issue](https://github.com/himanshu7745/omnideploy/issues).

---

## Contents

- [Install, update, uninstall](#install-update-uninstall)
- [Quick start](#quick-start)
- [What happens when you deploy](#what-happens-when-you-deploy)
- [Commands](#commands)
- [Supported projects](#supported-projects)
- [Providers at a glance](#providers-at-a-glance)
- [Provider guides](#provider-guides): [Vercel](#vercel) · [Netlify](#netlify) · [GitHub Pages](#github-pages) · [Railway](#railway) · [Render](#render)
- [Git: how omnideploy keeps your remote up to date](#git-how-omnideploy-keeps-your-remote-up-to-date)
- [Secrets: keeping `.env`, keys and passwords private](#secrets-keeping-env-keys-and-passwords-private)
- [Production environment variables: `.env.production`](#production-environment-variables-envproduction)
- [Credentials](#credentials)
- [omnideploy.json reference](#omnideployjson-reference)
- [Generated files](#generated-files)
- [Prompts, `--yes` and CI](#prompts---yes-and-ci)
- [Troubleshooting](#troubleshooting)
- [omnideploy's own environment variables](#omnideploys-own-environment-variables)
- [Development](#development)

---

## Install, update, uninstall

Requires **Node.js 20+**. Railway deployments also need the [Railway CLI](https://docs.railway.com/guides/cli).

```bash
npm install -g omnideploy-cli          # install the `omnideploy` command
npx omnideploy-cli <command>           # or run it without installing
```

**Update**

```bash
npm install -g omnideploy-cli@latest   # update a global install
omnideploy --version                   # the version you have
npm view omnideploy-cli version        # the latest published version
```

- `npx omnideploy-cli …` can reuse an old cached copy. Use `npx omnideploy-cli@latest …` to be sure you run the newest release.
- Right after a release, npm may still serve its cached metadata for a few minutes. If `@latest` installs the previous version, run `npm install -g omnideploy-cli@latest --prefer-online`, or name the version (`omnideploy-cli@0.3.0`).

**Uninstall**

```bash
npm uninstall -g omnideploy-cli
rm -rf ~/.config/omnideploy            # saved tokens (optional)
```

---

## Quick start

**First deploy**

```bash
cd my-project
omnideploy deploy render               # or vercel, netlify, github-pages, railway
```

If your app needs configuration (database URL, API keys…), put the production values in **`.env.production`** first — omnideploy sets them on the platform and tells you if one is missing. See [`.env.production`](#production-environment-variables-envproduction).

omnideploy asks for anything it needs along the way (a token, permission to write files, a repository name). Once a deploy succeeds, the provider's IDs are saved in `omnideploy.json` so the next deploy updates the same app.

**Redeploy after changing code**

```bash
omnideploy deploy                      # deploys to every provider in omnideploy.json
```

For Render, omnideploy lists your uncommitted changes and offers to commit and push them, so the new code is what gets built. See [Git](#git-how-omnideploy-keeps-your-remote-up-to-date).

**Set up first, deploy later**

```bash
omnideploy init                        # detect, pick providers, write deployment files + omnideploy.json
omnideploy login netlify               # save a token (or set NETLIFY_AUTH_TOKEN)
omnideploy doctor                      # check everything is in place
omnideploy deploy
```

**In CI**

```yaml
- run: npx omnideploy-cli@latest deploy netlify --yes
  env:
    NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
```

See [Prompts, `--yes` and CI](#prompts---yes-and-ci) for exactly what `--yes` does.

---

## What happens when you deploy

`omnideploy deploy <providers>` always runs these steps, in this order, and stops at the first one that fails:

1. **Detect** the project (language, framework, static site or server, port, build command). Values in `omnideploy.json` override detection.
2. **Pick providers**: the ones you named, otherwise those in `omnideploy.json`, otherwise it asks (non-interactive runs fail and list the compatible ones).
3. **Check compatibility.** If a provider can't host this project, or you asked for `--preview` on a provider without previews, it stops *before writing or deploying anything* and suggests an alternative.
4. **Check production variables.** It reads [`.env.production`](#production-environment-variables-envproduction). If the app needs a variable that is missing or empty, it stops here and says which.
5. **Generate missing deployment files.** It shows what it will write and asks first (`--yes` skips the question). Existing files are kept unless you pass `--force`.
6. **Get credentials** for each provider: environment variable, then saved token, then a prompt. Then each provider runs its own checks (for example, Railway checks that its CLI is installed).
7. **Sync git** (Render only, because it builds from your repository): create a GitHub repository if there's no remote, then commit and push what should be deployed.
8. **Build** static sites locally, with the `.env.production` values available to the build (server apps are built by the platform).
9. **Deploy** to each provider, setting the `.env.production` variables on it first where the app is built or runs remotely. If one provider fails, the others still run.
10. **Save** the IDs each provider returns (site, project, service) to `omnideploy.json`, and print a table of URLs.

The exit code is `0` if every deployment succeeded, `1` if anything failed or a required step was declined, and `130` if you cancelled (Ctrl-C, or **Cancel** in a menu).

---

## Commands

Global flags, accepted by every command:

| Flag | Meaning |
|---|---|
| `-C, --cwd <dir>` | Run as if started in `<dir>` (default: the current directory). |
| `--no-interactive` | Never prompt. Also implied by `CI=true` or a non-TTY stdin. |
| `--debug` | Show stack traces and debug output. |
| `-V, --version` / `-h, --help` | Version / help (also `omnideploy <command> --help`). |

### `deploy [providers...]`

Detects, generates missing files, builds and deploys. With no providers, it uses those in `omnideploy.json`.

| Flag | Meaning |
|---|---|
| `--preview` | Create a preview deployment instead of production. Only Vercel (preview URL) and Netlify (draft URL) support this; for other providers the deploy stops instead of going to production. |
| `--no-build` | Skip the local build and upload the existing output folder (static sites). |
| `-d, --dir <path>` | Deploy this folder as a static site, whatever the project is. |
| `--dry-run` | Show which files would be generated and which providers would be used. Nothing is written, built, committed, pushed or deployed. Missing tokens are reported as warnings. |
| `-y, --yes` | Answer yes to every question. See [what that means](#prompts---yes-and-ci). |
| `-f, --force` | Regenerate deployment files even if they already exist. |

```bash
omnideploy deploy                         # providers from omnideploy.json
omnideploy deploy vercel netlify          # several at once (the site is built once)
omnideploy deploy netlify --preview       # draft deploy
omnideploy deploy netlify --dir public    # upload a folder as-is
omnideploy deploy render --dry-run        # see the plan
```

### `init`

Detects the project, shows which providers fit (and why the others don't), writes the deployment files and an `omnideploy.json`. It doesn't deploy.

| Flag | Meaning |
|---|---|
| `-p, --providers <ids>` | Comma-separated providers, skipping the question (`-p render,netlify`). Incompatible ones are skipped with a warning. |
| `-y, --yes` | Accept defaults. Without `--providers`, this selects **every** compatible provider. |
| `-f, --force` | Overwrite existing deployment files. |

### `generate <providers...>` (alias `eject`)

Only writes the deployment files, for when you want to deploy some other way (or review them first).

| Flag | Meaning |
|---|---|
| `-f, --force` | Overwrite existing files. |
| `-y, --yes` | Write without asking. |
| `--dry-run` | List the files without writing them. |

### `login <provider>` / `logout <provider>`

Save or remove a token. `<provider>` is a provider id, or `github` for the token used to create GitHub repositories.

```bash
omnideploy login render                 # prompts for the token
omnideploy login render --token <value> # non-interactive
omnideploy logout render
```

`login` saves the token as given; it's checked on the next deploy. `logout` only removes the saved copy — see [Credentials](#credentials).

### `providers` (alias `ls`)

Lists every provider with what it hosts, where its token comes from (`env`, `store` or "login needed"), whether its CLI is installed, and — when run inside a project — whether it fits the project and why not.

### `doctor`

Checks Node.js, project detection, `omnideploy.json`, `.env.production` (are all required variables there?), git, and each provider's token, CLI and compatibility, with a fix for every problem. Exits with `1` if something must be fixed before deploying.

### `status <provider> [deploymentId]`

Shows the state, URL and time of the latest deployment (or a specific one), using the IDs saved in `omnideploy.json`. Supported for Vercel, Netlify, GitHub Pages and Render. Railway has no status command; use the Railway dashboard.

---

## Supported projects

omnideploy runs every detector and keeps the most confident match. A project with only a `Dockerfile` is still deployable, and `omnideploy.json` can describe a project no detector recognizes (set `app.start` for a server or `build.output` for a static site).

| Language | Detected from | Frameworks and what they're treated as | Default port |
|---|---|---|---|
| Node.js | `package.json` | **Static**: Vite (React, Vue, Svelte, Solid, Preact), Create React App, Angular, Gatsby, Astro, SvelteKit with `adapter-static`, Next.js with `output: 'export'`, any package with a `build` script (output `dist`). **Server**: Next.js, Nuxt, SvelteKit, Remix, Astro with `@astrojs/node`, NestJS, Express, Fastify, Koa, Hono, hapi. | 3000 (Astro SSR 4321) |
| Python | `requirements.txt`, `pyproject.toml`, `Pipfile`, `manage.py` | Django, FastAPI, Flask, Streamlit, plain scripts. pip, Poetry and uv. | 8000 (Flask 5000, Streamlit 8501) |
| Java | `pom.xml`, `build.gradle(.kts)` | Spring Boot, Quarkus, Micronaut. Maven and Gradle. | 8080 |
| Go | `go.mod` | Gin, Echo, Fiber, chi, net/http, `cmd/*` layouts | 8080 |
| Rust | `Cargo.toml` | Axum, Actix Web, Rocket, Warp, Poem | 8080 |
| Ruby | `Gemfile` | Rails, Sinatra | 3000 |
| PHP | `composer.json`, `index.php` | Laravel, Symfony, plain PHP | 8080 |
| .NET | `*.csproj` | ASP.NET Core | 8080 |
| Static | `index.html` | Plain HTML (deployed as-is) | — |
| Anything | `Dockerfile` | Your own image | 8080 |

The default port is only used when the platform doesn't set `$PORT`; on Render and Railway, `$PORT` always wins. Override detection in [`omnideploy.json`](#omnideployjson-reference): `build.command`, `build.output`, `app.start`, `app.port`.

---

## Providers at a glance

| | Vercel | Netlify | GitHub Pages | Railway | Render |
|---|:-:|:-:|:-:|:-:|:-:|
| Static sites | ✔ | ✔ | ✔ | ✔ (nginx image) | ✔ |
| Next.js / Nuxt / SvelteKit / Remix / Astro SSR | ✔ native | ✖ | ✖ | ✔ Docker | ✔ |
| Servers in any language | ✖ | ✖ | ✖ | ✔ Docker | ✔ native or Docker |
| `--preview` | ✔ preview URL | ✔ draft URL | ✖ | ✖ | ✖ |
| `status` command | ✔ | ✔ | ✔ | ✖ | ✔ |
| Builds from | your machine | your machine | your machine | upload via CLI | **your git remote** |
| Needs | token | token | token + GitHub repo | token + `railway` CLI | token + git repo (created for you) |
| Token env var | `VERCEL_TOKEN` | `NETLIFY_AUTH_TOKEN` | `GITHUB_TOKEN` | `RAILWAY_TOKEN` | `RENDER_API_KEY` |

If you ask a provider for something it can't host, omnideploy stops before doing any work and suggests one that can:

```
■  Vercel: only hosts static sites and nextjs, nuxt, sveltekit, remix or astro apps, not spring-boot servers
│  Try: Deploy to Railway or Render instead.
```

---

## Provider guides

Each guide lists what omnideploy does on the first deploy and on later deploys, the options it reads from `omnideploy.json`, and how it handles the situations that usually go wrong.

### Vercel

**Hosts:** static sites, and Next.js, Nuxt, SvelteKit, Remix and Astro natively. **Token:** `VERCEL_TOKEN` — create one at https://vercel.com/account/tokens.

- **Static sites** are built on your machine and the output folder is uploaded. A root `vercel.json` is uploaded with it.
- **Framework apps** (Next.js and so on) are uploaded as source and built by Vercel. Files ignored by `.gitignore`, `.env*`, `node_modules`, `.git` and local build folders (`.next`, `.nuxt`, `.output`, `.svelte-kit`, `dist`, `.vercel`) are not uploaded.
- Only files Vercel doesn't already have are uploaded (8 at a time).
- **Environment variables:** for framework apps, the variables in `.env.production` are set on the project (encrypted, for Production and Preview) before the build — on the first deploy the project is created first so the first build has them. Static sites don't need this: the local build already used the values.
- **Generated:** `vercel.json` with a rewrite to `/index.html`, only for single-page apps, so client-side routes work on refresh.
- **Production vs preview:** production returns the project's production domain; `--preview` returns the unique preview URL.
- **Saved to `omnideploy.json`:** `project` (name) and `projectId`.

| Option (`providers.vercel`) | Meaning |
|---|---|
| `project` | Project name for the first deploy. Default: the top-level `name`. |
| `projectId` | Saved automatically. Later deploys target this project by ID, so renaming it in the dashboard is fine. |
| `teamId` | Deploy into a team instead of your personal account. |

| Situation | What happens |
|---|---|
| A Vercel project with the same name already exists (first deploy) | Vercel deploys into that project. Set `providers.vercel.project` to a different name if it isn't yours. |
| Token belongs to a team but `teamId` isn't set | Vercel returns 403/404. Set `teamId`. |
| Build fails on Vercel | `Vercel deployment failed: …` with a link to the build logs. |
| `status` before the first deploy | "No Vercel project yet — deploy first." |
| `.env`, keys or other [secret files](#secrets-keeping-env-keys-and-passwords-private) in the upload | Never uploaded (warning). Set the values as Vercel environment variables. |

### Netlify

**Hosts:** static sites only. **Token:** `NETLIFY_AUTH_TOKEN` — create one at https://app.netlify.com/user/applications#personal-access-tokens.

- The site is built on your machine and the output folder is uploaded as a zip.
- **Single-page apps** get a `_redirects` file (`/*  /index.html  200`) added to the upload, because zip deploys ignore redirects in `netlify.toml`.
- **Generated:** `netlify.toml` (publish folder, build command, Node version, SPA redirect). It isn't used by zip deploys; it's there so the settings are right if you later connect the repository in Netlify.
- **Production vs preview:** production updates the live site; `--preview` creates a draft deploy with its own URL.
- **Saved to `omnideploy.json`:** `siteId` and `siteName`.

| Option (`providers.netlify`) | Meaning |
|---|---|
| `siteName` | Preferred site name (`<name>.netlify.app`). Default: the top-level `name`. |
| `siteId` | Saved automatically after the first deploy. |

| Situation | What happens |
|---|---|
| The site name is taken (names are global on Netlify) | A short random suffix is added (`demo-x7k2p`). Set `siteName` to choose your own. |
| The saved site was deleted in the dashboard | A warning, then a new site is created and its ID saved. |
| Build output folder is missing or empty | Stops before uploading, with how to fix it (`build.output`, or drop `--no-build`). |
| Server app (Express, Django, …) | Not supported — use Railway or Render. |
| `.env`, keys or other [secret files](#secrets-keeping-env-keys-and-passwords-private) in the output folder | Never uploaded (warning), since every file on the site is public. |

### GitHub Pages

**Hosts:** static sites only. **Token:** `GITHUB_TOKEN` — a classic token with the `repo` scope (https://github.com/settings/tokens), or a fine-grained token with *Contents* and *Pages* write access.

- The site is built on your machine. The output is published to the `gh-pages` branch, and Pages is enabled for that branch through the API.
- The repository comes from your GitHub `origin` remote, or from `providers["github-pages"].repo`.
- Added to the published files: `.nojekyll` (so folders starting with `_` work), `CNAME` if you set `cname`, and `404.html` (a copy of `index.html`) for single-page apps.
- Waits up to 3 minutes for the Pages build, then reports the URL.
- **Saved to `omnideploy.json`:** `repo` and `branch`.

> **The publish branch is overwritten on every deploy.** Each deploy force-pushes a single commit to `gh-pages`. Don't keep anything else on that branch.

| Option (`providers["github-pages"]`) | Meaning |
|---|---|
| `repo` | `owner/repo`. Default: the `origin` remote. |
| `branch` | Publish branch. Default: `gh-pages`. |
| `cname` | Custom domain (writes `CNAME`). |

| Situation | What happens |
|---|---|
| No GitHub remote | Stops: add one (`git remote add origin https://github.com/<you>/<repo>.git`) or set `repo`. |
| Project site served under `/<repo>/` | Warns for Vite, CRA and Angular: set the base path (Vite `base: '/<repo>/'`, CRA `"homepage"`), otherwise assets 404. User sites (`<you>.github.io`) and custom domains don't need this. |
| Private repository on a free GitHub plan | Stops: Pages on private repos needs a paid plan. Make the repo public, or use Netlify or Vercel. |
| Token lacks permissions | Push fails with the token redacted from the message; give it `repo` scope. |
| `.env`, keys or other [secret files](#secrets-keeping-env-keys-and-passwords-private) in the output folder | Never published (warning), since everything on Pages is public. |

### Railway

**Hosts:** static sites (nginx image) and servers in any language (Docker). **Token:** `RAILWAY_TOKEN` — a **project token** (Project → Settings → Tokens), not an account token. **Requires** the Railway CLI: `npm i -g @railway/cli` or `brew install railway`.

- Runs `railway up --ci` in the project folder. The CLI uploads the project and Railway builds it from the generated `Dockerfile`, using `railway.json`.
- Before that, sets the variables from `.env.production` on the service (`railway variable set … --skip-deploys`, so it doesn't trigger an extra deploy). Older CLIs are handled too.
- Then runs `railway domain` to get (or create) the public URL.
- **Generated:** `Dockerfile`, `.dockerignore`, `railway.json` (build from the Dockerfile, health check on `app.healthCheckPath` or `/`, restart on failure up to 5 times).
- Nothing needs saving: the project token identifies the project.

| Option (`providers.railway`) | Meaning |
|---|---|
| `service` | Service to deploy to. Required if the project has more than one service. |
| `environment` | Environment, e.g. `production` or `staging`. |

| Situation | What happens |
|---|---|
| Railway CLI not installed | Stops before deploying, with the install command. |
| The project has several services | Stops: set `providers.railway.service`. |
| Account token instead of project token | Stops with how to create a project token. |
| Unknown environment | Stops: check `providers.railway.environment`. |
| Static site with build-time variables (`VITE_*`) | Railway builds static sites inside Docker, where variables only reach the build if the Dockerfile declares them (`ARG VITE_API_URL` in the build stage). Netlify or Vercel are simpler for static sites. |
| Deployed, but no domain could be created | Succeeds with a warning and no URL; add a domain in the Railway dashboard. |
| `--preview` | Not supported — deploy to a separate `environment` instead. |
| Token in CLI output | Always redacted (`***`). |

### Render

**Hosts:** static sites and servers in any language. **Token:** `RENDER_API_KEY` — create one at https://dashboard.render.com/u/settings#api-keys.

Render builds **from your git repository**, not from your machine, so omnideploy makes sure the repository has what you want deployed before it deploys. See [Git](#git-how-omnideploy-keeps-your-remote-up-to-date) for the details.

- **Runtime:** Node, Python, Ruby and Go run on Render's native runtimes (Render installs dependencies with the generated build command). Other languages, and any project with its own `Dockerfile`, use Docker.
- **First deploy:** creates a web service (or static site) through the API: plan `free`, region `oregon`, the current branch, auto-deploy on, health check on `app.healthCheckPath` (or `/`). Static sites get an install-and-build command (`npm ci && npm run build`) and, for single-page apps, a `/* → /index.html` rewrite.
- **Environment variables:** the variables in `.env.production` are part of the create request, so the first build has them. On later deploys they are added or updated through the API — Render's API replaces the whole list, so omnideploy reads the current one first and keeps variables you added in the dashboard. Nothing is rewritten if nothing changed.
- **Later deploys:** deploy the saved service. If omnideploy just pushed a commit, Render's auto-deploy is already building it, so omnideploy follows that build instead of starting a second one. Otherwise it starts a deploy of the pushed commit (or the branch's latest).
- **Generated:** `render.yaml` (a Render Blueprint with the same settings), plus `Dockerfile` and `.dockerignore` when Docker is used. omnideploy creates the service through the API, so editing `render.yaml` later doesn't change an existing service — use the dashboard, or Render Blueprints if you prefer infrastructure as code.
- **Saved to `omnideploy.json`:** `serviceId` and `ownerId`.

| Option (`providers.render`) | Meaning |
|---|---|
| `serviceName` | Name for the new service. Default: the top-level `name`. |
| `serviceId` | Saved automatically after the first deploy. |
| `ownerId` | Render workspace. Default: your first workspace (with a warning if you have several). |
| `branch` | Branch to build. Default: the current branch. |
| `plan` | Instance type, e.g. `free`, `starter`, `standard`. Default: `free`. |
| `region` | e.g. `oregon`, `frankfurt`, `singapore`. Default: `oregon`. |
| `healthCheckPath` | Overrides `app.healthCheckPath` for Render. |

| Situation | What happens |
|---|---|
| No git repository or no remote | Offers to create a **private GitHub repository** and push the project to it. See [below](#no-remote-yet-render). |
| Render can't read the (private) repository | Asks *"Render needs access to <repo>. Open the page to grant it and continue deploying?"* **Yes** opens GitHub's page for Render's app in your browser, waits for you to click Save, and retries. **No** stops the deploy. With `--yes`/CI it reports the error instead. Choosing **All repositories** on that page means it never asks again. |
| A service with the same name already exists | If it builds the same repo, omnideploy reuses it. Otherwise it creates the service as `<name>-<5 chars>` (stable for this repo) and warns. If you set `serviceName` yourself, it stops and asks you to pick another. |
| The saved service was deleted in the dashboard | A warning, then a new service is created and its ID saved. |
| A deploy is already running when omnideploy triggers one | Render queues it; omnideploy follows the newest deploy. |
| Several Render workspaces | Uses the first and warns; set `ownerId` to choose. |
| Remote isn't GitHub, GitLab or Bitbucket | Stops: Render can only build from those. |
| `--preview` | Not supported (Render previews come from pull requests). |
| `.env` or hard-coded passwords (e.g. in `application.yml`) | Never pushed: secret files go to `.gitignore`, and you choose what happens to files with hard-coded secrets. See [Secrets](#secrets-keeping-env-keys-and-passwords-private). |
| A variable changed in `.env.production` right after a push | Render's auto-deploy of the push started with the old values, so omnideploy starts a fresh build of the same commit with the new ones. |
| A variable the app needs is missing from `.env.production` | Stops before deploying; see [`.env.production`](#production-environment-variables-envproduction). |
| Free plan | Free services sleep when idle, so the first request after a while is slow. |

---

## Git: how omnideploy keeps your remote up to date

This applies to providers that build from git — currently **Render**. Every deploy compares your working copy with the remote and only asks when something is missing.

### On every deploy

| Your repository | What omnideploy does |
|---|---|
| Up to date with the remote | Nothing; it deploys straight away. |
| Uncommitted changes | Lists them and asks what to deploy: **Commit and push all changes** (recommended), **Only deployment files** (when both kinds changed), **Deploy the last pushed commit** (when only code changed), or **Cancel**. |
| Commits that were never pushed | Asks to push them. |
| Branch never pushed | Asks to push it. |
| `--yes` | Commits and pushes everything, without asking. |
| Non-interactive without `--yes` | Stops with how to proceed (commit and push yourself, or add `--yes`). |

- Commit messages: `Deploy with omnideploy` when code is included, `chore: add deployment configuration (omnideploy)` for generated files only.
- **Secrets are never committed automatically.** Secret files (`.env`, keys, …) are left out and can be added to `.gitignore`; files you do commit are checked for hard-coded passwords and tokens first. See [Secrets](#secrets-keeping-env-keys-and-passwords-private).
- If the push is rejected because the remote has commits you don't have, omnideploy stops: run `git pull --rebase`, then deploy again.
- If your machine has no git identity configured, commits are made as `omnideploy <omnideploy@users.noreply.github.com>`.

### No remote yet (Render)

If the project isn't a git repository, or has no `origin`, omnideploy offers to set one up (or does it straight away with `--yes`):

1. Asks for the repository name (default: the service name).
2. Gets a GitHub token: `GITHUB_TOKEN`, then a saved `github` login, then your `gh` CLI login, and only then asks you to paste one (classic token with `repo` scope: https://github.com/settings/tokens/new?scopes=repo).
3. If the folder isn't a repository: runs `git init` on `main`, and writes a default `.gitignore` if there isn't one (it excludes `node_modules/`, `.env*`, `*.pem`, `*.key`, `application-local.*`, `.streamlit/secrets.toml`, `.venv/`, `__pycache__/`, `target/`, `obj/`, `vendor/`, logs).
4. Makes an initial commit, after the [secrets check](#secrets-keeping-env-keys-and-passwords-private): secret files go to `.gitignore`, and files with hard-coded secrets are left out unless you choose to commit them. All of this happens *before* anything is created on GitHub.
5. Creates a **private** repository on your account, adds it as `origin`, and pushes. The first push uses the token, so it works even if git has no GitHub credentials set up; the token isn't stored in `.git/config`.
6. Tries to give Render's GitHub app access to the new repository. Classic tokens aren't allowed to do this, so usually the [repository access question](#render) comes up during the deploy instead.

**One-time setup on Render:** connect GitHub in the Render dashboard (Account settings → Git). GitHub only lets you install an app from the browser, so omnideploy can't do this for you.

---

## Secrets: keeping `.env`, keys and passwords private

Secrets belong in **environment variables** on the platform, not in git and not in uploaded files. omnideploy enforces that in the three places where a secret could leak, in every language.

### 1. Secret files are never committed or uploaded

These files are recognized by name, wherever they are in the project:

| Kind | Files |
|---|---|
| dotenv (Node, Python, PHP/Laravel, Ruby, Go, Rust, …) | `.env`, `.env.local`, `.env.production`, any `.env.*` — except templates: `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.defaults` |
| Keys and certificates | `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.p8`, `*.ppk`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` |
| Credential files | `credentials.json`, `client_secret*.json`, `service-account*.json`, `.netrc`, `.git-credentials`, `.htpasswd`, `.pgpass` |
| Framework-specific | Spring Boot `application-local.yml` / `-secret` / `-secrets` / `-private` (`.yml`, `.yaml`, `.properties`); Streamlit `.streamlit/secrets.toml`; Azure Functions `local.settings.json`; Rails `config/master.key` |
| Infrastructure | `*.tfvars`, `*.tfstate` |

When one of these is about to be committed (Render), omnideploy leaves it out and offers to **add it to `.gitignore`** so it never comes up again (with `--yes` it adds it without asking). When deploying to **Vercel, Netlify or GitHub Pages**, these files are **never uploaded**, even if they sit in the output folder — on a static host anyone could download `https://your-site/.env`.

### 2. Files you commit are checked for hard-coded secrets

Some files must be committed even though they *can* contain secrets — Spring's `application.yml`, .NET's `appsettings.json`, `docker-compose.yml`, Maven's `settings.xml`. Before committing, omnideploy reads the files it's about to commit and looks for:

- **Token formats, in any file (code included):** private key blocks, AWS access keys, GitHub/GitLab/Slack/npm tokens, Stripe live keys, Google, OpenAI and Anthropic API keys, SendGrid keys.
- **Passwords in connection URLs:** `postgres://user:password@host/db`, `mongodb+srv://…`, `redis://…` (except `localhost`).
- **Secret settings in config files** (`.yml`, `.yaml`, `.properties`, `.toml`, `.ini`, `.json`, `.xml`, `.conf`, `.npmrc`): keys such as `password`, `secret`, `api_key`, `client_secret`, `private_key`, `token`, and `Password=…;` in connection strings — when the value is a literal.

Values that are clearly not secrets are ignored: references like `${DB_PASSWORD}`, `${{ secrets.X }}`, `ENV['X']`, `os.environ[…]`, placeholders like `changeme` or `your-api-key`, numbers, and common local-dev defaults (`postgres`, `root`, `admin`, `guest`). Commented-out settings are ignored too, but a real token format is reported even in a comment.

If something is found, you see the file, line and kind, with the value **masked** (`S3•••s!` — never printed in full), and choose:

| Choice | Effect |
|---|---|
| **Leave these files out of the commit** (default; always used with `--yes`) | The rest is committed and deployed; the remote keeps the previous version of those files. |
| **Commit them anyway** | For values that aren't really secret (test fixtures, public keys, demo data). |
| **Cancel** | Nothing is committed or deployed. |

### 3. Secrets that were committed before

If a secret file is already tracked by git, omnideploy warns on every Render deploy, with the fix. Removing it from git is not enough on its own — it stays in the history, so **rotate** it:

```bash
git rm --cached .env          # stop tracking (the file stays on your machine)
echo ".env" >> .gitignore
git commit -m "Stop tracking .env"
# then create new keys/passwords and revoke the old ones
```

### Where the real values go

In **`.env.production`** — the one secret file whose values omnideploy *uses*: it sets them on the provider as environment variables, and never commits or uploads the file itself. See the next section.

Notes:
- Generated `.dockerignore` files exclude `.env` and `.env.*`, so they never end up in a Docker image.
- Railway uploads your project with its CLI, which skips files listed in `.gitignore` — another reason to keep `.env` there.
- Tokens for omnideploy itself never appear in its output; see [Credentials](#credentials).

---

## Production environment variables: `.env.production`

**`.env.production` in the project root is the single source of truth for production configuration** — database URLs, API keys, JWT secrets, feature flags. You keep it on your machine (it's git-ignored and never uploaded), and every deploy makes its values available to the app on the platform. Your code doesn't change: it reads environment variables (`process.env.X`, `os.environ["X"]`, Spring `${X}`, `System.getenv`) exactly as before.

```dotenv
# .env.production
DATABASE_URL=postgres://app:Xk29fj2@db.example.com:5432/app
JWT_SECRET="a long random value"
STRIPE_KEY=sk_live_...
```

### What happens on every deploy

| Where the app is built or runs | What omnideploy does with `.env.production` |
|---|---|
| Static sites built on your machine (Netlify, GitHub Pages, Vercel static) | Passes the variables to the local build, so values like `VITE_API_URL` end up in the bundle. Nothing is sent to the provider. |
| **Render** (servers and static sites) | Sets them on the service: in the create request on the first deploy, then adds or updates them through the API, keeping variables you added in the dashboard. |
| **Railway** | `railway variable set … --skip-deploys` before `railway up`. |
| **Vercel** framework apps (Next.js, Nuxt, …) | Upserts them into the project (encrypted, Production and Preview) before the build. |

- **Add or update only.** Deleting a line from `.env.production` doesn't delete the variable on the provider — remove it in the dashboard.
- **`PORT` is ignored:** the platform sets it, and overriding it breaks routing.
- **Values are never printed** — only variable names appear in the output.
- **`localhost` values are flagged:** `DATABASE_URL=postgres://…@localhost/…` points at the server itself once deployed, not at your machine, so you get a warning.
- Syntax: `KEY=value`, `export KEY=value`, `"double"` or `'single'` quotes, `#` comments, multi-line values in double quotes.

### Required variables — and what happens when they're missing

omnideploy works out which variables your app needs from:

- **Variable names** in `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.defaults` and `.env` (only the names; those values are never used).
- **Spring Boot, Quarkus and Micronaut placeholders without a default** — `${DB_PASSWORD}` in `application.yml`, `application.properties`, `application-prod.*` (in `src/main/resources/`, the project root or `config/`). `${DB_USER:app}` has a default, so it's not required; `${server.port}` refers to another property, not the environment.

If one of them is missing from `.env.production`, or is empty, **the deploy stops before anything is generated, pushed or deployed** and tells you exactly which variables and where they're expected:

```
■  The app needs production environment variables, but there is no .env.production for DATABASE_URL, DB_PASSWORD
   (the app expects them, see src/main/resources/application.yml).
│  Try: Put the production values in .env.production in the project root (KEY=value per line). …
```

In an interactive terminal it also offers to **create (or complete) `.env.production`** with those names and empty values, and adds it to `.gitignore`; fill in the values and deploy again. `omnideploy doctor` runs the same check without deploying.

| You want to… | Do this |
|---|---|
| Allow a variable to be missing or empty | List it in `omnideploy.json` → `"env": { "optional": ["SENTRY_DSN"] }` |
| Manage variables in the dashboards instead | `"env": { "sync": false }` — nothing is checked or sent |
| See the variables on the platform | Render: service → Environment · Railway: service → Variables · Vercel: Project → Settings → Environment Variables |

If no `.env.production` exists and nothing suggests the app needs variables, deploys work as before.

### In CI

`.env.production` is git-ignored, so a CI checkout doesn't have it. Store the whole file as one CI secret and write it before deploying:

```yaml
- run: printf '%s\n' "$ENV_PRODUCTION" > .env.production
  env:
    ENV_PRODUCTION: ${{ secrets.ENV_PRODUCTION }}
- run: npx omnideploy-cli@latest deploy render --yes
  env:
    RENDER_API_KEY: ${{ secrets.RENDER_API_KEY }}
```

### Per language: development vs production

Commit a file that *reads* values from the environment, keep development values in `.env` (or your framework's local file), and production values in `.env.production`.

| Language | Committed (no real values) | Local development | How the app reads them |
|---|---|---|---|
| **Java / Spring Boot** | `application.yml` with `password: ${DB_PASSWORD}` (or `${DB_PASSWORD:devpass}` for a local default) | `application-local.yml` with `SPRING_PROFILES_ACTIVE=local`, or `.env` via `spring.config.import: optional:file:.env[.properties]` | `${VAR}` placeholders |
| **Java / Quarkus, Micronaut** | `application.properties` / `.yml` with `${DB_PASSWORD}` | `.env` (Quarkus reads it in dev mode) | `${VAR}` placeholders |
| **Node.js** | `.env.example` with the variable names | `.env` | `process.env.X` (Node 20.6+: `node --env-file=.env`, or `dotenv`) |
| **Python / Django / FastAPI / Flask** | `.env.example`; Django `SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]` | `.env` | `os.environ["X"]` (`python-dotenv` locally) |
| **Ruby on Rails** | `config/credentials.yml.enc` (encrypted) | `config/master.key` | Put `RAILS_MASTER_KEY=…` in `.env.production` |
| **PHP / Laravel** | `.env.example` | `.env` | `env('X')` |
| **.NET** | `appsettings.json` without secrets | `dotnet user-secrets` | `Configuration["X"]`; use `ConnectionStrings__Default` style names in `.env.production` |
| **Go / Rust** | `.env.example` | `.env` | `os.Getenv` / `std::env::var` (`godotenv`, `dotenvy` locally) |
| **Static sites** | `.env.example` | `.env` | Build-time variables (`VITE_*`, `NEXT_PUBLIC_*`) end up **public** in the bundle — only put public values there |

---

## Credentials

Tokens are looked up in this order: **environment variable → saved token → prompt**. A token you paste at a prompt is saved for next time.

| Id | Used for | Env var | Create a token |
|---|---|---|---|
| `vercel` | Vercel | `VERCEL_TOKEN` | https://vercel.com/account/tokens |
| `netlify` | Netlify | `NETLIFY_AUTH_TOKEN` | https://app.netlify.com/user/applications#personal-access-tokens |
| `github-pages` | GitHub Pages | `GITHUB_TOKEN` | https://github.com/settings/tokens (`repo` scope) |
| `github` | Creating repositories for Render | `GITHUB_TOKEN`, or your `gh` CLI login | https://github.com/settings/tokens (`repo` scope) |
| `railway` | Railway | `RAILWAY_TOKEN` | Project → Settings → Tokens (a **project** token) |
| `render` | Render | `RENDER_API_KEY` | https://dashboard.render.com/u/settings#api-keys |

Saved tokens live in `~/.config/omnideploy/credentials.json`, readable only by you (mode `0600`). Change the folder with `OMNIDEPLOY_CONFIG_DIR` (or `XDG_CONFIG_HOME`; `%APPDATA%\omnideploy` on Windows).

### Change or remove a token

```bash
omnideploy login render            # replace: paste a new token (overwrites the saved one)
omnideploy login render --token …  # same, non-interactive
omnideploy logout render           # remove the saved token
omnideploy login github            # the GitHub token used to create repositories
omnideploy logout github
omnideploy providers               # see where each token comes from
```

- An environment variable always wins over a saved token. If one is set, change it or `unset` it too.
- `logout` only removes the saved copy. To make a token stop working, also revoke it in the provider's dashboard.
- A `gh` CLI login is managed by `gh` itself: `gh auth logout` / `gh auth login`.
- Tokens never appear in omnideploy's output: anything that might contain one (CLI output, git errors) is redacted to `***`.

---

## omnideploy.json reference

Everything is optional. `init` writes this file; deploys add the IDs providers return, so later deploys update the same apps. Values here always override detection. Editors validate the file against [`schema.json`](./schema.json).

```json
{
  "$schema": "https://unpkg.com/omnideploy-cli/schema.json",
  "name": "demo-api",
  "build": { "command": "npm run build", "output": "dist" },
  "app": { "start": "node server.js", "port": 3000, "healthCheckPath": "/health" },
  "env": { "optional": ["SENTRY_DSN"] },
  "providers": {
    "vercel": { "teamId": "team_123" },
    "netlify": { "siteName": "demo-site" },
    "github-pages": { "branch": "gh-pages", "cname": "www.example.com" },
    "railway": { "service": "api", "environment": "production" },
    "render": { "plan": "starter", "region": "frankfurt" }
  }
}
```

| Field | Meaning |
|---|---|
| `name` | Name used for new sites, projects, services and repositories. Default: `name` from `package.json` (or similar), else the folder name, turned into a lowercase slug. |
| `build.command` | Build command for static sites. |
| `build.output` | Folder with the built site, relative to the project. |
| `app.start` | Start command for servers. It must listen on `$PORT`. |
| `app.port` | Port used when the platform doesn't set `$PORT`. |
| `app.healthCheckPath` | Path Render and Railway probe to decide the app is healthy (must start with `/`). Default: `/`. |
| `env.optional` | Variables the app can run without; they may be missing or empty in `.env.production`. |
| `env.sync` | `false` turns off the `.env.production` check and stops omnideploy from setting variables on providers. Default: `true`. |
| `providers.<id>` | Per-provider options — see each [provider guide](#provider-guides). |

Values for environment variables never go in this file — they live in [`.env.production`](#production-environment-variables-envproduction).

**Deploying to a fresh app:** delete the provider's saved ID (`siteId`, `projectId`, `serviceId`) to make the next deploy create a new site, project or service. If you deleted the app in the provider's dashboard, you don't need to — Netlify and Render notice and create a new one.

---

## Generated files

| File | For | Notes |
|---|---|---|
| `Dockerfile` | Railway; Render when Docker is used | Multi-stage, pins the detected runtime version, runs as a non-root user, listens on `$PORT`. Static sites are served by unprivileged nginx. |
| `.dockerignore` | Same as `Dockerfile` | Keeps the build context small and secrets out of the image. |
| `render.yaml` | Render | Blueprint with the same settings the service is created with. |
| `railway.json` | Railway | Build from the Dockerfile, health check, restart policy. |
| `vercel.json` | Vercel, single-page apps only | Rewrite to `/index.html`. |
| `netlify.toml` | Netlify | Build settings and SPA redirect, for if you connect the repo in Netlify later. |

- Before writing, omnideploy shows the list of files and can show their contents.
- **An existing file is never overwritten** unless you pass `--force`. Your own `Dockerfile` is always used as-is.
- Files are shared between providers: deploying to Railway and Render together writes one `Dockerfile`.
- Review the generated files and commit them — they're ordinary project files you can edit.

---

## Prompts, `--yes` and CI

omnideploy only asks when it needs a decision. When the terminal isn't interactive (`--no-interactive`, `CI=true`, or piped stdin) it never waits for input: it either proceeds because you passed `--yes`, or stops with a message that says how to proceed.

| Question | Interactive answer | With `--yes` | Non-interactive without `--yes` |
|---|---|---|---|
| Which provider? (none given, none in `omnideploy.json`) | Pick from the compatible ones | Stops; lists compatible providers | Stops; lists compatible providers |
| A required variable is missing from `.env.production` | Offers to create/complete the file for you to fill in, then stops | Stops; names the variables | Stops; names the variables |
| Write these deployment files? | Yes / No (optional preview) | Writes them | Stops; suggests `--yes` or `generate` |
| Token missing | Paste it (saved) | Stops (set the env var) | Stops (set the env var) |
| Create a GitHub repository? (Render, no remote) | Yes / No, then the name | Creates it, private, default name | Stops; suggests `--yes` |
| Commit and push changes? (Render) | All / deployment files / last pushed / cancel | Commits and pushes everything | Stops; suggests `--yes` |
| Secret files like `.env` about to be committed | Never committed; asks to add them to `.gitignore` | Never committed; added to `.gitignore` | — (stops earlier) |
| Hard-coded secrets in files about to be committed | Leave out / commit anyway / cancel | Left out, with a warning | — (stops earlier) |
| Grant Render access to the repository? | Opens the browser and retries | Reports the error | Reports the error |

**CI tips**

- Pass tokens as environment variables (secrets), never with `--token`, so they don't end up in logs.
- Store `.env.production` as one secret and write it to the project before deploying — see [In CI](#in-ci).
- Commit `omnideploy.json` after the first deploy so CI updates the same apps instead of creating new ones.
- For GitHub Pages in GitHub Actions, give the workflow `permissions: contents: write` so it can push `gh-pages`. If enabling Pages fails there, enable it once by hand (repository Settings → Pages → branch `gh-pages`); later deploys only push.

---

## Troubleshooting

Every error is printed as one line saying what went wrong, followed by `Try: …` with the fix. Add `--debug` to see the stack trace. Start with `omnideploy doctor`.

| Message starts with | Meaning and fix |
|---|---|
| `The app needs production environment variables, but …` | A variable the app uses is missing or empty in `.env.production`. Add it, or list it under `env.optional` in `omnideploy.json`. |
| `Created .env.production — fill in …` | omnideploy created the file for you; set the values and deploy again. |
| `… point(s) to localhost` | That value only works on your machine. Use the hosted database/service address in `.env.production`. |
| `Railway deployment failed: could not set environment variables` | Check `providers.railway.service`, or set them in the Railway dashboard. |
| `Vercel API error: could not set environment variables` | A name Vercel rejects; rename it in `.env.production`. |
| `Could not detect a supported project` | No detector matched. Add a `Dockerfile`, or set `app.start` (server) or `build.output` (static) in `omnideploy.json`. |
| `<Provider>: only hosts static sites…` / `cannot run…` | That provider can't host this project; the hint names one that can. |
| `<Provider> has no preview deployments` | Drop `--preview`, or preview on Vercel or Netlify. |
| `No credentials found for <provider>` | `omnideploy login <provider>`, or set the env var. |
| `Required tool "railway" is not installed` | `npm i -g @railway/cli`. |
| `Deployment files need to be generated, but the terminal is not interactive` | Add `--yes`, or run `omnideploy generate <provider>` and commit the files. |
| `Build failed` | The hint shows the last lines of output. Fix the build locally, or set `build.command`. |
| `Build output directory "…" does not exist` / `is empty` | Set `build.output` to the folder your build writes; if you used `--no-build`, build first. |
| `… builds from your git remote, which does not have your local changes yet` | Commit and push, or re-run with `--yes`. |
| `… has no git remote` | Re-run interactively or with `--yes` to create a GitHub repo, or add a remote yourself. |
| `Not uploading .env, …: they look like secrets` | Expected: secret files are never published. Move the values to environment variables. |
| `Left out <file>, so the deployed version of that file stays as last pushed` | The file has a hard-coded secret. Replace the value with `${ENV_VAR}` and set the variable on the platform, then deploy again. |
| `<file> is committed to git, so … anyone with access to the repository can read it` | `git rm --cached <file>`, add it to `.gitignore`, and rotate the secret. |
| `The remote has commits you do not have locally` | `git pull --rebase`, then deploy again. |
| `Could not create GitHub repository "…"` | The name exists or is invalid; pick another name. |
| `Render cannot access <repo>` | Give Render's GitHub app access to the repository (omnideploy offers to open the page). |
| `The Render service name "…" is already used` | Change `providers.render.serviceName`, or set `serviceId` to deploy to the existing service. |
| `Render cannot use the git remote` | Use a GitHub, GitLab or Bitbucket remote. |
| `GitHub Pages needs a GitHub repository` | Add a GitHub `origin`, or set `providers["github-pages"].repo`. |
| `GitHub Pages could not be enabled` | Private repo on a free plan: make it public, or use Netlify or Vercel. |
| `<Provider> API error (401)` / `(403)` | Token invalid, expired, or missing permissions: `omnideploy login <provider>`. |
| `<Provider> API error (404)` | Something saved in `omnideploy.json` no longer exists; remove that ID. |
| `<Provider> API error (429)` | Rate limited. omnideploy already retried; wait and try again. |
| `<Provider> deployment failed` | The platform's build failed; the hint links to the logs. |
| `omnideploy.json is invalid` | The message lists each wrong field. |
| `npm error You cannot publish over the previously published versions` | (Publishing omnideploy itself) bump the version first: `npm version patch`. |

Network requests are retried automatically on timeouts, rate limits and 5xx errors.

---

## omnideploy's own environment variables

| Variable | Effect |
|---|---|
| `VERCEL_TOKEN`, `NETLIFY_AUTH_TOKEN`, `GITHUB_TOKEN`, `RAILWAY_TOKEN`, `RENDER_API_KEY` | Provider tokens (take precedence over saved ones). |
| `OMNIDEPLOY_CONFIG_DIR` | Folder for `credentials.json` (default `~/.config/omnideploy`). |
| `XDG_CONFIG_HOME` / `APPDATA` | Base for the default config folder on Linux/macOS / Windows. |
| `CI` | Any value turns off prompts. |

---

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

To add a provider, detector or file generator, implement the matching domain port (`DeploymentProvider`, `ProjectDetector`, `ArtifactGenerator`) in `src/infrastructure/…` and register it in that folder's `index.ts`. Declare what the provider supports in its `capabilities` (`kinds`, `serverLanguages`, `previews`, `buildsFromGit`, `requiredCli`, `auth`, `gitHostApps`); compatibility checks, `--preview` handling and git syncing are driven by them. Nothing in `domain` or `application` needs to change. Then add the provider to this README: the [at-a-glance table](#providers-at-a-glance), a [guide](#provider-guides), and the [credentials table](#credentials).

**Releasing:** bump the version (`npm version patch|minor`), then `npm publish`. `prepublishOnly` runs the checks and the build.

## License

MIT
