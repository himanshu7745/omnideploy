import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeployContext, ProjectProfile } from '../../src/domain/index.js';
import { FetchHttpClient } from '../../src/infrastructure/http/FetchHttpClient.js';
import { GitHubRepositoryHost } from '../../src/infrastructure/git/GitHubRepositoryHost.js';
import { GitHubPagesProvider } from '../../src/infrastructure/providers/GitHubPagesProvider.js';
import { NetlifyProvider } from '../../src/infrastructure/providers/NetlifyProvider.js';
import { RailwayProvider } from '../../src/infrastructure/providers/RailwayProvider.js';
import { RenderProvider, toHttpsRepo } from '../../src/infrastructure/providers/RenderProvider.js';
import { VercelProvider } from '../../src/infrastructure/providers/VercelProvider.js';
import { FakeGit, FakeProcess, MemoryFs, MemoryLogger } from '../helpers/fakes.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const FAST = { intervalMs: 1, timeoutMs: 1000 };
const httpClient = new FetchHttpClient({ retries: 0 });
const ROOT = '/work/site';

const staticProfile: ProjectProfile = { rootDir: ROOT, language: 'node', framework: 'vite-react', kind: 'static', outputDir: 'dist', port: 8080, hasDockerfile: false };
const serverProfile: ProjectProfile = { rootDir: ROOT, language: 'java', framework: 'spring-boot', kind: 'server', port: 8080, hasDockerfile: true };

function ctx(over: Partial<DeployContext> = {}): DeployContext & { progressLog: string[] } {
  const progressLog: string[] = [];
  return {
    profile: staticProfile,
    options: {},
    token: 'tok',
    sourceDir: `${ROOT}/dist`,
    production: true,
    serviceName: 'demo',
    env: {},
    logger: new MemoryLogger(),
    progress: (m) => progressLog.push(m),
    progressLog,
    ...over,
  };
}

const siteFs = () =>
  new MemoryFs(
    new Map([
      [`${ROOT}/dist/index.html`, '<h1>hi</h1>'],
      [`${ROOT}/dist/assets/app.js`, 'console.log(1)'],
      [`${ROOT}/vercel.json`, '{"rewrites":[]}'],
    ]),
  );

describe('NetlifyProvider', () => {
  it('creates a site, uploads a zip with SPA _redirects, polls until ready', async () => {
    const calls: string[] = [];
    let zipBytes = 0;
    let polls = 0;
    server.use(
      http.post('https://api.netlify.com/api/v1/sites', async ({ request }) => {
        calls.push(`create ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ id: 'site-1', name: 'demo', ssl_url: 'https://demo.netlify.app', url: 'http://demo.netlify.app' });
      }),
      http.post('https://api.netlify.com/api/v1/sites/site-1/deploys', async ({ request }) => {
        calls.push(`deploy ${request.headers.get('content-type')} auth=${request.headers.get('authorization')}`);
        zipBytes = (await request.arrayBuffer()).byteLength;
        return HttpResponse.json({ id: 'dep-1', state: 'uploaded' });
      }),
      http.get('https://api.netlify.com/api/v1/deploys/dep-1', () => HttpResponse.json({ id: 'dep-1', state: ++polls < 3 ? 'processing' : 'ready' })),
    );

    const d = await new NetlifyProvider(httpClient, siteFs(), FAST).deploy(ctx());

    expect(calls).toEqual(['create {"name":"demo"}', 'deploy application/zip auth=Bearer tok']);
    expect(zipBytes).toBeGreaterThan(100);
    expect(polls).toBe(3);
    expect(d).toMatchObject({ id: 'dep-1', state: 'ready', url: 'https://demo.netlify.app', configUpdates: { siteId: 'site-1', siteName: 'demo' } });
  });

  it('retries with a suffix when the site name is taken', async () => {
    const names: string[] = [];
    server.use(
      http.post('https://api.netlify.com/api/v1/sites', async ({ request }) => {
        const { name } = (await request.json()) as { name: string };
        names.push(name);
        return names.length === 1 ? HttpResponse.json({ errors: 'taken' }, { status: 422 }) : HttpResponse.json({ id: 's2', name, url: `http://${name}.netlify.app` });
      }),
      http.post('https://api.netlify.com/api/v1/sites/s2/deploys', () => HttpResponse.json({ id: 'd', state: 'ready', ssl_url: 'https://x' })),
      http.get('https://api.netlify.com/api/v1/deploys/d', () => HttpResponse.json({ id: 'd', state: 'ready' })),
    );
    await new NetlifyProvider(httpClient, siteFs(), FAST).deploy(ctx());
    expect(names[0]).toBe('demo');
    expect(names[1]).toMatch(/^demo-[a-z0-9]+$/);
  });

  it('surfaces deploy errors', async () => {
    server.use(
      http.get('https://api.netlify.com/api/v1/sites/s1', () => HttpResponse.json({ id: 's1', name: 'x', url: 'u' })),
      http.post('https://api.netlify.com/api/v1/sites/s1/deploys', () => HttpResponse.json({ id: 'd', state: 'uploaded' })),
      http.get('https://api.netlify.com/api/v1/deploys/d', () => HttpResponse.json({ id: 'd', state: 'error', error_message: 'bad headers file' })),
    );
    await expect(new NetlifyProvider(httpClient, siteFs(), FAST).deploy(ctx({ options: { siteId: 's1' } }))).rejects.toThrow(/bad headers file/);
  });

  it('maps a 401 to an actionable hint', async () => {
    server.use(http.get('https://api.netlify.com/api/v1/sites/s1', () => HttpResponse.json({ message: 'Access Denied' }, { status: 401 })));
    const err = await new NetlifyProvider(httpClient, siteFs(), FAST).deploy(ctx({ options: { siteId: 's1' } })).catch((e) => e);
    expect(err.message).toBe('Netlify API error (401): Access Denied');
    expect(err.hint).toMatch(/omnideploy login/);
  });
});

describe('VercelProvider', () => {
  it('uploads only missing files, then creates the deployment and returns the production alias', async () => {
    const uploaded: string[] = [];
    let creates = 0;
    let manifest: Array<{ file: string }> = [];
    server.use(
      http.post('https://api.vercel.com/v13/deployments', async ({ request }) => {
        creates++;
        const body = (await request.json()) as { files: Array<{ file: string; sha: string }>; target?: string };
        manifest = body.files;
        if (creates === 1) {
          return HttpResponse.json({ error: { code: 'missing_files', missing: [body.files[0]!.sha] } }, { status: 400 });
        }
        expect(body.target).toBe('production');
        return HttpResponse.json({ id: 'dpl_1', url: 'demo-abc.vercel.app', readyState: 'QUEUED' });
      }),
      http.post('https://api.vercel.com/v2/files', ({ request }) => {
        uploaded.push(request.headers.get('x-vercel-digest')!);
        return HttpResponse.json({});
      }),
      http.get('https://api.vercel.com/v13/deployments/dpl_1', () =>
        HttpResponse.json({ id: 'dpl_1', url: 'demo-abc.vercel.app', readyState: 'READY', alias: ['demo.vercel.app'], projectId: 'prj_1' }),
      ),
    );

    const d = await new VercelProvider(httpClient, siteFs(), FAST).deploy(ctx());

    expect(creates).toBe(2);
    expect(uploaded).toHaveLength(1);
    expect(manifest.map((f) => f.file).sort()).toEqual(['assets/app.js', 'index.html', 'vercel.json']);
    expect(d).toMatchObject({ url: 'https://demo.vercel.app', state: 'ready', configUpdates: { project: 'demo', projectId: 'prj_1' } });
  });

  it('reports build errors with the inspector link', async () => {
    server.use(
      http.post('https://api.vercel.com/v13/deployments', () => HttpResponse.json({ id: 'dpl_2', url: 'x.vercel.app' })),
      http.get('https://api.vercel.com/v13/deployments/dpl_2', () =>
        HttpResponse.json({ id: 'dpl_2', url: 'x.vercel.app', readyState: 'ERROR', errorMessage: 'Build failed', inspectorUrl: 'https://vercel.com/i/2' }),
      ),
    );
    const err = await new VercelProvider(httpClient, siteFs(), FAST).deploy(ctx()).catch((e) => e);
    expect(err.message).toBe('Vercel deployment failed: Build failed');
    expect(err.hint).toBe('Build logs: https://vercel.com/i/2');
  });
});

describe('RenderProvider', () => {
  it('creates a docker web service from the git remote on first deploy', async () => {
    let createBody: Record<string, any> = {};
    server.use(
      http.get('https://api.render.com/v1/owners', () => HttpResponse.json([{ owner: { id: 'own-1', name: 'me' } }])),
      http.post('https://api.render.com/v1/services', async ({ request }) => {
        createBody = (await request.json()) as Record<string, any>;
        return HttpResponse.json({ service: { id: 'srv-1', name: 'demo' }, deployId: 'dep-1' });
      }),
      http.get('https://api.render.com/v1/services/srv-1/deploys/dep-1', () => HttpResponse.json({ id: 'dep-1', status: 'live' })),
      http.get('https://api.render.com/v1/services/srv-1', () =>
        HttpResponse.json({ id: 'srv-1', name: 'demo', serviceDetails: { url: 'https://demo.onrender.com' }, dashboardUrl: 'https://dashboard.render.com/web/srv-1' }),
      ),
    );

    const d = await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: serverProfile, sourceDir: ROOT }));

    expect(createBody).toMatchObject({
      type: 'web_service',
      name: 'demo',
      ownerId: 'own-1',
      repo: 'https://github.com/acme/app',
      branch: 'main',
      serviceDetails: { runtime: 'docker', plan: 'free', envSpecificDetails: { dockerfilePath: './Dockerfile' } },
    });
    expect(d).toMatchObject({ url: 'https://demo.onrender.com', state: 'ready', configUpdates: { serviceId: 'srv-1', ownerId: 'own-1' } });
  });

  it('triggers a new deploy for an existing service and reports build failures', async () => {
    server.use(
      http.post('https://api.render.com/v1/services/srv-9/deploys', () => HttpResponse.json({ id: 'dep-9', status: 'created' })),
      http.get('https://api.render.com/v1/services/srv-9/deploys/dep-9', () => HttpResponse.json({ id: 'dep-9', status: 'build_failed' })),
      http.get('https://api.render.com/v1/services/srv-9', () => HttpResponse.json({ id: 'srv-9', name: 'demo', dashboardUrl: 'https://dash/srv-9' })),
    );
    const err = await new RenderProvider(httpClient, new FakeGit(), FAST)
      .deploy(ctx({ profile: serverProfile, options: { serviceId: 'srv-9' } }))
      .catch((e) => e);
    expect(err.message).toBe('Render deployment failed: build failed');
    expect(err.hint).toBe('Logs: https://dash/srv-9/deploys/dep-9');
  });

  it('needs Docker only where Render has no native runtime', () => {
    const p = new RenderProvider(httpClient, new FakeGit(), FAST);
    expect(p.requiredArtifacts(serverProfile)).toEqual(['dockerfile', 'dockerignore', 'render-yaml']);
    expect(p.requiredArtifacts({ ...serverProfile, language: 'python', hasDockerfile: false })).toEqual(['render-yaml']);
  });

  it.each([
    ['git@github.com:acme/app.git', 'https://github.com/acme/app'],
    ['https://token@github.com/acme/app.git', 'https://github.com/acme/app'],
    ['https://gitlab.com/group/sub/app', 'https://gitlab.com/group/sub/app'],
    ['https://example.com/x.git', null],
  ])('toHttpsRepo(%s)', (input, expected) => {
    expect(toHttpsRepo(input)).toBe(expected);
  });
});

describe('GitHubPagesProvider', () => {
  it('publishes a prepared copy to gh-pages and enables Pages', async () => {
    const fs = siteFs();
    const git = new FakeGit();
    let snapshot: Map<string, string> = new Map();
    git.publishDirectory = async (dir, remoteUrl, branch) => {
      snapshot = new Map([...fs.files].filter(([k]) => k.startsWith(dir)).map(([k, v]) => [k.slice(dir.length + 1), v]));
      git.published.push({ dir, remoteUrl, branch });
    };
    let enabled: unknown;
    server.use(
      http.get('https://api.github.com/repos/acme/app/pages', () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })),
      http.post('https://api.github.com/repos/acme/app/pages', async ({ request }) => {
        enabled = await request.json();
        return HttpResponse.json({ html_url: 'https://acme.github.io/app/' });
      }),
      http.get('https://api.github.com/repos/acme/app/pages/builds/latest', () => HttpResponse.json({ status: 'built', commit: 'abc123' })),
    );

    const d = await new GitHubPagesProvider(httpClient, fs, git, FAST).deploy(ctx({ options: { cname: 'www.example.com' } }));

    expect(git.published[0]).toMatchObject({ remoteUrl: 'https://x-access-token:tok@github.com/acme/app.git', branch: 'gh-pages' });
    expect([...snapshot.keys()].sort()).toEqual(['.nojekyll', '404.html', 'CNAME', 'assets/app.js', 'index.html']);
    expect(snapshot.get('CNAME')).toBe('www.example.com\n');
    expect(enabled).toEqual({ source: { branch: 'gh-pages', path: '/' } });
    expect(d).toMatchObject({ url: 'https://www.example.com/', state: 'ready', id: 'abc123' });
    expect([...fs.files.keys()].some((k) => k.startsWith('/tmp/'))).toBe(false); // temp dir cleaned up
  });

  it('never leaks the token in git errors', async () => {
    const git = new FakeGit();
    git.publishDirectory = async (_d, remoteUrl) => {
      throw new Error(`fatal: unable to access '${remoteUrl}'`);
    };
    const err = await new GitHubPagesProvider(httpClient, siteFs(), git, FAST).deploy(ctx({ token: 'ghp_secret' })).catch((e) => e);
    expect(err.message).not.toContain('ghp_secret');
    expect(err.message).toContain('***');
  });

  it('requires a GitHub remote', async () => {
    const p = new GitHubPagesProvider(httpClient, siteFs(), new FakeGit({ url: 'https://gitlab.com/a/b' }), FAST);
    await expect(p.validate({ profile: staticProfile, rootDir: ROOT, options: {} })).rejects.toThrow(/needs a GitHub repository/);
  });
});

describe('RailwayProvider', () => {
  it('runs `railway up` with the token in the environment and reads the domain', async () => {
    const proc = new FakeProcess(
      (_bin, args) =>
        args[0] === 'up'
          ? { stdout: 'Build Logs: https://railway.com/project/p1/service/s1?id=dep-42\nDeploy complete' }
          : { stdout: 'Service Domain: https://demo-production.up.railway.app' },
      ['railway'],
    );
    const d = await new RailwayProvider(proc).deploy(ctx({ profile: serverProfile, options: { service: 'api' } }));
    expect(proc.calls[0]).toMatchObject({ bin: 'railway', args: ['up', '--ci', '--service', 'api'], env: { RAILWAY_TOKEN: 'tok' } });
    expect(d).toMatchObject({ id: 'dep-42', url: 'https://demo-production.up.railway.app', state: 'ready' });
  });

  it('explains how to install the CLI when missing', async () => {
    await expect(new RailwayProvider(new FakeProcess()).validate()).rejects.toThrow(/"railway" is not installed/);
  });

  it('fails with the output tail and never echoes the token', async () => {
    const proc = new FakeProcess(() => ({ exitCode: 1, stderr: 'Unauthorized token rw_secret_123' }), ['railway']);
    const err = await new RailwayProvider(proc).deploy(ctx({ profile: serverProfile, token: 'rw_secret_123' })).catch((e) => e);
    expect(err.message).toBe('Railway deployment failed: Unauthorized token ***');
  });
});

describe('GitHubRepositoryHost', () => {
  it('creates a private repository for the authenticated user', async () => {
    let body: unknown;
    let authz: string | null = null;
    server.use(
      http.post('https://api.github.com/user/repos', async ({ request }) => {
        body = await request.json();
        authz = request.headers.get('authorization');
        return HttpResponse.json(
          { name: 'demo', owner: { login: 'me' }, clone_url: 'https://github.com/me/demo.git', html_url: 'https://github.com/me/demo' },
          { status: 201 },
        );
      }),
    );
    const repo = await new GitHubRepositoryHost(httpClient, new FakeProcess()).createRepository('tok', { name: 'demo', private: true });
    expect(body).toEqual({ name: 'demo', private: true, auto_init: false });
    expect(authz).toBe('Bearer tok');
    expect(repo).toEqual({ owner: 'me', name: 'demo', cloneUrl: 'https://github.com/me/demo.git', webUrl: 'https://github.com/me/demo' });
  });

  it('explains a name clash', async () => {
    server.use(
      http.post('https://api.github.com/user/repos', () =>
        HttpResponse.json({ message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }, { status: 422 }),
      ),
    );
    const err = await new GitHubRepositoryHost(httpClient, new FakeProcess()).createRepository('tok', { name: 'demo', private: true }).catch((e) => e);
    expect(err.message).toMatch(/already exists/);
    expect(err.hint).toMatch(/different name/);
  });

  it('reuses an existing gh CLI login', async () => {
    const proc = new FakeProcess((bin, args) => (bin === 'gh' && args.join(' ') === 'auth token' ? { stdout: 'gho_abc\n' } : {}), ['gh']);
    expect(await new GitHubRepositoryHost(httpClient, proc).detectToken()).toBe('gho_abc');
    expect(await new GitHubRepositoryHost(httpClient, new FakeProcess()).detectToken()).toBeNull();
  });
});

describe('RenderProvider repository access', () => {
  it('explains how to grant Render access when the repo is unfetchable', async () => {
    server.use(
      http.get('https://api.render.com/v1/owners', () => HttpResponse.json([{ owner: { id: 'own-1', name: 'Me' } }])),
      http.post('https://api.render.com/v1/services', () =>
        HttpResponse.json({ message: 'passed in repository URL is invalid or unfetchable: https://github.com/acme/app' }, { status: 400 }),
      ),
    );
    const err = await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: serverProfile, sourceDir: ROOT })).catch((e) => e);
    expect(err.message).toBe('Render cannot access https://github.com/acme/app.');
    expect(err.grantUrl).toBe('https://github.com/apps/render/installations/new');
    expect(err.hint).toMatch(/github\.com\/settings\/installations.*acme\/app/);
  });
});

describe('GitHubRepositoryHost.grantAppAccess', () => {
  const repo = { id: 42, owner: 'Me', name: 'demo', cloneUrl: '', webUrl: '' };
  const host = () => new GitHubRepositoryHost(httpClient, new FakeProcess());
  const installs = (selection: string, slug = 'render') =>
    http.get('https://api.github.com/user/installations', () =>
      HttpResponse.json({ installations: [{ id: 7, app_slug: 'other', repository_selection: 'selected', account: { login: 'me' } }, { id: 9, app_slug: slug, repository_selection: selection, account: { login: 'me' } }] }),
    );

  it('adds the repo to a selected-repositories installation', async () => {
    let put = '';
    server.use(
      installs('selected'),
      http.put('https://api.github.com/user/installations/:inst/repositories/:repo', ({ params }) => {
        put = `${params.inst}/${params.repo}`;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    expect(await host().grantAppAccess('tok', repo, 'render')).toBe('granted');
    expect(put).toBe('9/42');
  });

  it('does nothing when the app can already see all repositories', async () => {
    server.use(installs('all'));
    expect(await host().grantAppAccess('tok', repo, 'render')).toBe('already');
  });

  it('reports unknown-installation when the token may not list installations (personal tokens)', async () => {
    server.use(http.get('https://api.github.com/user/installations', () => HttpResponse.json({ message: 'You must authenticate with an access token authorized to a GitHub App' }, { status: 403 })));
    expect(await host().grantAppAccess('tok', repo, 'render')).toBe('unknown-installation');
  });

  it('reports unavailable when the app is not installed or the token is refused', async () => {
    server.use(installs('selected', 'netlify'));
    expect(await host().grantAppAccess('tok', repo, 'render')).toBe('unavailable');
    server.use(installs('selected'), http.put('https://api.github.com/user/installations/:inst/repositories/:repo', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })));
    expect(await host().grantAppAccess('tok', repo, 'render')).toBe('unavailable');
  });
});

describe('RenderProvider service name already in use', () => {
  const taken = () => HttpResponse.json({ message: 'name: (demo) already in use' }, { status: 400 });
  const common = (id: string) => [
    http.get('https://api.render.com/v1/owners', () => HttpResponse.json([{ owner: { id: 'own-1', name: 'Me' } }])),
    http.get(`https://api.render.com/v1/services/${id}/deploys/dep-1`, () => HttpResponse.json({ id: 'dep-1', status: 'live' })),
    http.get(`https://api.render.com/v1/services/${id}`, () => HttpResponse.json({ id, name: 'x', serviceDetails: { url: `https://${id}.onrender.com` } })),
  ];

  it('reuses the existing service when it builds the same repo', async () => {
    let triggered = false;
    server.use(
      ...common('srv-old'),
      http.post('https://api.render.com/v1/services', taken),
      http.get('https://api.render.com/v1/services', ({ request }) => {
        expect(new URL(request.url).searchParams.get('name')).toBe('demo');
        return HttpResponse.json([{ service: { id: 'srv-old', name: 'demo', repo: 'https://github.com/acme/app.git' } }]);
      }),
      http.post('https://api.render.com/v1/services/srv-old/deploys', () => {
        triggered = true;
        return HttpResponse.json({ id: 'dep-1', status: 'created' });
      }),
    );
    const c = ctx({ profile: serverProfile, sourceDir: ROOT });
    const d = await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(c);
    expect(triggered).toBe(true);
    expect(d.configUpdates).toMatchObject({ serviceId: 'srv-old' });
  });

  it('picks a stable repo-specific name when the existing service is for another repo', async () => {
    const names: string[] = [];
    server.use(
      ...common('srv-new'),
      http.post('https://api.render.com/v1/services', async ({ request }) => {
        const name = ((await request.json()) as { name: string }).name;
        names.push(name);
        return name === 'demo' ? taken() : HttpResponse.json({ service: { id: 'srv-new', name }, deployId: 'dep-1' });
      }),
      http.get('https://api.render.com/v1/services', () => HttpResponse.json([{ service: { id: 'srv-other', name: 'demo', repo: 'https://github.com/someone/else' } }])),
    );
    const c = ctx({ profile: serverProfile, sourceDir: ROOT });
    const d = await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(c);
    expect(names[0]).toBe('demo');
    expect(names[1]).toMatch(/^demo-[a-z0-9]{1,5}$/);
    expect(d.configUpdates).toMatchObject({ serviceId: 'srv-new' });
    expect((c.logger as MemoryLogger).lines.some((l) => l.includes('already exists for another repo'))).toBe(true);
  });

  it('respects an explicit serviceName and explains the clash', async () => {
    server.use(
      ...common('srv-x'),
      http.post('https://api.render.com/v1/services', taken),
      http.get('https://api.render.com/v1/services', () => HttpResponse.json([{ service: { id: 'srv-other', name: 'demo', repo: 'https://github.com/someone/else' } }])),
    );
    const err = await new RenderProvider(httpClient, new FakeGit(), FAST)
      .deploy(ctx({ profile: serverProfile, sourceDir: ROOT, options: { serviceName: 'demo' } }))
      .catch((e) => e);
    expect(err.code).toBe('RENDER_NAME_TAKEN');
    expect(err.hint).toMatch(/serviceName/);
  });
});

describe('Render edge cases', () => {
  const owners = http.get('https://api.render.com/v1/owners', () => HttpResponse.json([{ owner: { id: 'own-1', name: 'Me' } }]));
  const finished = (id: string, dep = 'dep-1') => [
    http.get(`https://api.render.com/v1/services/${id}/deploys/${dep}`, () => HttpResponse.json({ id: dep, status: 'live' })),
    http.get(`https://api.render.com/v1/services/${id}`, () => HttpResponse.json({ id, name: 'demo', autoDeploy: 'yes', serviceDetails: { url: `https://${id}.onrender.com` } })),
  ];
  const viteProfile: ProjectProfile = { ...staticProfile, buildCommand: 'npm run build', meta: { install: 'npm ci', lockfile: 'package-lock.json' } };

  it('static Vite site: installs deps in the build command and adds the SPA rewrite', async () => {
    let body: Record<string, any> = {};
    let route: unknown;
    server.use(
      owners,
      ...finished('srv-s'),
      http.post('https://api.render.com/v1/services', async ({ request }) => {
        body = (await request.json()) as Record<string, any>;
        return HttpResponse.json({ service: { id: 'srv-s', name: 'demo' }, deployId: 'dep-1' });
      }),
      http.post('https://api.render.com/v1/services/srv-s/routes', async ({ request }) => {
        route = await request.json();
        return HttpResponse.json({ id: 'rt-1' });
      }),
    );
    await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: viteProfile, sourceDir: ROOT }));
    expect(body).toMatchObject({ type: 'static_site', serviceDetails: { buildCommand: 'npm ci && npm run build', publishPath: 'dist' } });
    expect(route).toEqual({ type: 'rewrite', source: '/*', destination: '/index.html' });
  });

  it('a failed SPA rewrite only warns', async () => {
    server.use(
      owners,
      ...finished('srv-s'),
      http.post('https://api.render.com/v1/services', () => HttpResponse.json({ service: { id: 'srv-s', name: 'demo' }, deployId: 'dep-1' })),
      http.post('https://api.render.com/v1/services/srv-s/routes', () => HttpResponse.json({ message: 'nope' }, { status: 400 })),
    );
    const c = ctx({ profile: viteProfile, sourceDir: ROOT });
    const d = await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(c);
    expect(d.state).toBe('ready');
    expect((c.logger as MemoryLogger).lines.some((l) => l.includes('Redirects/Rewrites'))).toBe(true);
  });

  it('uses app.healthCheckPath for new web services', async () => {
    let body: Record<string, any> = {};
    server.use(
      owners,
      ...finished('srv-h'),
      http.post('https://api.render.com/v1/services', async ({ request }) => {
        body = (await request.json()) as Record<string, any>;
        return HttpResponse.json({ service: { id: 'srv-h', name: 'demo' }, deployId: 'dep-1' });
      }),
    );
    await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: { ...serverProfile, healthCheckPath: '/actuator/health' }, sourceDir: ROOT }));
    expect(body.serviceDetails.healthCheckPath).toBe('/actuator/health');
  });

  it('recreates the service when the saved serviceId was deleted', async () => {
    let created = false;
    server.use(
      owners,
      http.get('https://api.render.com/v1/services/srv-gone', () => HttpResponse.json({ message: 'not found' }, { status: 404 })),
      ...finished('srv-new'),
      http.post('https://api.render.com/v1/services', () => {
        created = true;
        return HttpResponse.json({ service: { id: 'srv-new', name: 'demo' }, deployId: 'dep-1' });
      }),
    );
    const c = ctx({ profile: serverProfile, sourceDir: ROOT, options: { serviceId: 'srv-gone' } });
    const d = await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(c);
    expect(created).toBe(true);
    expect(d.configUpdates).toMatchObject({ serviceId: 'srv-new' });
    expect((c.logger as MemoryLogger).lines.some((l) => l.includes('srv-gone no longer exists'))).toBe(true);
  });

  it('after a push, follows the auto-deploy for that commit instead of starting a second build', async () => {
    let triggered = false;
    let polls = 0;
    server.use(
      ...finished('srv-1', 'dep-auto'),
      http.get('https://api.render.com/v1/services/srv-1/deploys', () =>
        HttpResponse.json(++polls < 2 ? [{ deploy: { id: 'dep-old', status: 'live', commit: { id: 'old' } } }] : [{ deploy: { id: 'dep-auto', status: 'build_in_progress', commit: { id: 'f00d' } } }]),
      ),
      http.post('https://api.render.com/v1/services/srv-1/deploys', () => {
        triggered = true;
        return HttpResponse.json({ id: 'dep-x', status: 'created' });
      }),
    );
    const d = await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: serverProfile, options: { serviceId: 'srv-1' }, pushedCommit: 'f00d' }));
    expect(triggered).toBe(false);
    expect(d.id).toBe('dep-auto');
  });

  it('triggers that exact commit when auto-deploy does not pick it up', async () => {
    let body: unknown;
    server.use(
      ...finished('srv-1', 'dep-2'),
      http.get('https://api.render.com/v1/services/srv-1/deploys', () => HttpResponse.json([])),
      http.post('https://api.render.com/v1/services/srv-1/deploys', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 'dep-2', status: 'created' });
      }),
    );
    await new RenderProvider(httpClient, new FakeGit(), FAST, 5).deploy(ctx({ profile: serverProfile, options: { serviceId: 'srv-1' }, pushedCommit: 'f00d' }));
    expect(body).toEqual({ clearCache: 'do_not_clear', commitId: 'f00d' });
  });

  it('follows the newest deploy when Render answers 202 Queued without a body', async () => {
    server.use(
      ...finished('srv-1', 'dep-q'),
      http.post('https://api.render.com/v1/services/srv-1/deploys', () => new HttpResponse(null, { status: 202 })),
      http.get('https://api.render.com/v1/services/srv-1/deploys', () => HttpResponse.json([{ deploy: { id: 'dep-q', status: 'queued' } }])),
    );
    const d = await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: serverProfile, options: { serviceId: 'srv-1' } }));
    expect(d.id).toBe('dep-q');
  });

  it('rejects remotes Render cannot build from', async () => {
    const p = new RenderProvider(httpClient, new FakeGit({ url: 'https://example.com/me/app.git' }), FAST);
    await expect(p.validate({ rootDir: ROOT, options: {} })).rejects.toThrow(/cannot use the git remote/);
  });
});

describe('Netlify edge cases', () => {
  it('creates a new site when the saved siteId was deleted', async () => {
    server.use(
      http.get('https://api.netlify.com/api/v1/sites/site-gone', () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })),
      http.post('https://api.netlify.com/api/v1/sites', () => HttpResponse.json({ id: 'site-2', name: 'demo', ssl_url: 'https://demo.netlify.app', url: '' })),
      http.post('https://api.netlify.com/api/v1/sites/site-2/deploys', () => HttpResponse.json({ id: 'd1', state: 'uploaded' })),
      http.get('https://api.netlify.com/api/v1/deploys/d1', () => HttpResponse.json({ id: 'd1', state: 'ready' })),
    );
    const c = ctx({ options: { siteId: 'site-gone' } });
    const d = await new NetlifyProvider(httpClient, siteFs(), FAST).deploy(c);
    expect(d.configUpdates).toMatchObject({ siteId: 'site-2' });
    expect((c.logger as MemoryLogger).lines.some((l) => l.includes('site-gone no longer exists'))).toBe(true);
  });
});

describe('Vercel edge cases', () => {
  it('deploys into the saved project by ID', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post('https://api.vercel.com/v13/deployments', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 'dpl_1', url: 'demo-abc.vercel.app', readyState: 'READY', alias: ['demo.vercel.app'] });
      }),
      http.get('https://api.vercel.com/v13/deployments/dpl_1', () => HttpResponse.json({ id: 'dpl_1', url: 'demo-abc.vercel.app', readyState: 'READY', alias: ['demo.vercel.app'] })),
    );
    await new VercelProvider(httpClient, siteFs(), FAST).deploy(ctx({ options: { project: 'demo', projectId: 'prj_1' } }));
    expect(body).toMatchObject({ name: 'demo', project: 'prj_1' });
  });

  it('status before the first deploy does not list the whole account', async () => {
    const s = await new VercelProvider(httpClient, siteFs(), FAST).status({ options: {}, token: 'tok' });
    expect(s).toMatchObject({ state: 'unknown', message: 'No Vercel project yet — deploy first.' });
  });

  it('shows Vercel\'s message instead of raw JSON on a 400', async () => {
    server.use(http.post('https://api.vercel.com/v13/deployments', () => HttpResponse.json({ error: { code: 'bad_request', message: 'Invalid project name' } }, { status: 400 })));
    const err = await new VercelProvider(httpClient, siteFs(), FAST).deploy(ctx()).catch((e) => e);
    expect(err.message).toBe('Vercel API error (400): Invalid project name');
  });
});

describe('Railway edge cases', () => {
  it.each([
    ['Multiple services found. Please specify a service to deploy to via the --service flag.', /providers\.railway\.service/],
    ['Unauthorized. Please login with `railway login`', /project\* token/],
    ['Environment "staging" not found', /providers\.railway\.environment/],
  ])('explains: %s', async (out, hint) => {
    const proc = new FakeProcess(() => ({ exitCode: 1, stderr: out }), ['railway']);
    const err = await new RailwayProvider(proc).deploy(ctx({ profile: serverProfile })).catch((e) => e);
    expect(err.hint).toMatch(hint);
  });

  it('warns when the deploy worked but no domain could be created', async () => {
    const proc = new FakeProcess((_b, args) => (args[0] === 'up' ? { stdout: 'Deploy complete' } : { exitCode: 1, stderr: 'Error: domain limit reached' }), ['railway']);
    const c = ctx({ profile: serverProfile });
    const d = await new RailwayProvider(proc).deploy(c);
    expect(d.url).toBeUndefined();
    expect((c.logger as MemoryLogger).lines).toContain('warn: Railway deployed, but no public URL could be created: Error: domain limit reached');
  });
});

describe('GitHub Pages edge cases', () => {
  it('explains that private repos need a paid plan', async () => {
    server.use(
      http.get('https://api.github.com/repos/acme/app/pages', () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })),
      http.post('https://api.github.com/repos/acme/app/pages', () =>
        HttpResponse.json({ message: 'Your current plan does not support GitHub Pages for this repository.' }, { status: 422 }),
      ),
    );
    const err = await new GitHubPagesProvider(httpClient, siteFs(), new FakeGit(), FAST).deploy(ctx()).catch((e) => e);
    expect(err.code).toBe('PAGES_UNAVAILABLE');
    expect(err.hint).toMatch(/paid plan/);
  });
});

describe('static uploads never include secret files', () => {
  const leakyFs = () =>
    new MemoryFs(
      new Map([
        [`${ROOT}/dist/index.html`, '<h1>hi</h1>'],
        [`${ROOT}/dist/.env`, 'API_KEY=secret'],
        [`${ROOT}/dist/deploy.pem`, '-----BEGIN PRIVATE KEY-----'],
        [`${ROOT}/dist/.env.example`, 'API_KEY='],
      ]),
    );

  it('Vercel', async () => {
    let manifest: string[] = [];
    server.use(
      http.post('https://api.vercel.com/v13/deployments', async ({ request }) => {
        manifest = ((await request.json()) as { files: Array<{ file: string }> }).files.map((f) => f.file);
        return HttpResponse.json({ id: 'dpl_1', url: 'demo.vercel.app', readyState: 'READY' });
      }),
      http.get('https://api.vercel.com/v13/deployments/dpl_1', () => HttpResponse.json({ id: 'dpl_1', url: 'demo.vercel.app', readyState: 'READY' })),
    );
    const c = ctx();
    await new VercelProvider(httpClient, leakyFs(), FAST).deploy(c);
    expect(manifest.sort()).toEqual(['.env.example', 'index.html']);
    expect((c.logger as MemoryLogger).lines).toContain(
      'warn: Not uploading .env, deploy.pem: they look like secrets, and anything on a static host can be downloaded by anyone.',
    );
  });

  it('Netlify', async () => {
    let zipBytes = new Uint8Array();
    server.use(
      http.post('https://api.netlify.com/api/v1/sites', () => HttpResponse.json({ id: 's1', name: 'demo', url: 'http://demo.netlify.app' })),
      http.post('https://api.netlify.com/api/v1/sites/s1/deploys', async ({ request }) => {
        zipBytes = new Uint8Array(await request.arrayBuffer());
        return HttpResponse.json({ id: 'd1', state: 'uploaded' });
      }),
      http.get('https://api.netlify.com/api/v1/deploys/d1', () => HttpResponse.json({ id: 'd1', state: 'ready' })),
    );
    await new NetlifyProvider(httpClient, leakyFs(), FAST).deploy(ctx());
    const names = new TextDecoder('latin1').decode(zipBytes);
    expect(names).toContain('index.html');
    expect(names).toContain('.env.example');
    expect(names).not.toMatch(/\.env(?!\.example)/);
    expect(names).not.toContain('deploy.pem');
  });

  it('GitHub Pages', async () => {
    const fs = leakyFs();
    const git = new FakeGit();
    let published: string[] = [];
    git.publishDirectory = async (dir) => {
      published = (await fs.collectFiles(dir)).sort();
    };
    server.use(
      http.get('https://api.github.com/repos/acme/app/pages', () => HttpResponse.json({ html_url: 'https://acme.github.io/app/', source: { branch: 'gh-pages', path: '/' } })),
      http.get('https://api.github.com/repos/acme/app/pages/builds/latest', () => HttpResponse.json({ status: 'built', commit: 'c1' })),
    );
    await new GitHubPagesProvider(httpClient, fs, git, FAST).deploy(ctx());
    expect(published).toEqual(['.env.example', '.nojekyll', '404.html', 'index.html']);
    expect(fs.files.get(`${ROOT}/dist/.env`)).toBe('API_KEY=secret'); // the original is untouched
  });
});

describe('environment variables from .env.production', () => {
  const finished = (id: string, dep: string) => [
    http.get(`https://api.render.com/v1/services/${id}/deploys/${dep}`, () => HttpResponse.json({ id: dep, status: 'live' })),
    http.get(`https://api.render.com/v1/services/${id}`, () => HttpResponse.json({ id, name: 'demo', autoDeploy: 'yes', serviceDetails: { url: 'https://x.onrender.com' } })),
  ];
  const ENV = { DATABASE_URL: 'postgres://u:new@db.example.com/app', JWT_SECRET: 'jwt-123' };

  it('Render, new service: variables are part of the create request, so the first build has them', async () => {
    let body: Record<string, any> = {};
    server.use(
      http.get('https://api.render.com/v1/owners', () => HttpResponse.json([{ owner: { id: 'own-1', name: 'Me' } }])),
      ...finished('srv-n', 'dep-1'),
      http.post('https://api.render.com/v1/services', async ({ request }) => {
        body = (await request.json()) as Record<string, any>;
        return HttpResponse.json({ service: { id: 'srv-n', name: 'demo' }, deployId: 'dep-1' });
      }),
    );
    await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: serverProfile, sourceDir: ROOT, env: ENV }));
    expect(body.envVars).toEqual([
      { key: 'DATABASE_URL', value: ENV.DATABASE_URL },
      { key: 'JWT_SECRET', value: 'jwt-123' },
    ]);
  });

  it('Render, existing service: merges, keeping variables set in the dashboard (the API replaces the whole list)', async () => {
    let put: unknown;
    server.use(
      ...finished('srv-1', 'dep-2'),
      http.get('https://api.render.com/v1/services/srv-1/env-vars', () =>
        HttpResponse.json([
          { envVar: { key: 'SET_IN_DASHBOARD', value: 'keep-me' }, cursor: 'c1' },
          { envVar: { key: 'DATABASE_URL', value: 'postgres://u:old@db.example.com/app' }, cursor: 'c2' },
        ]),
      ),
      http.put('https://api.render.com/v1/services/srv-1/env-vars', async ({ request }) => {
        put = await request.json();
        return HttpResponse.json([]);
      }),
      http.post('https://api.render.com/v1/services/srv-1/deploys', () => HttpResponse.json({ id: 'dep-2', status: 'created' })),
    );
    const c = ctx({ profile: serverProfile, options: { serviceId: 'srv-1' }, env: ENV });
    await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(c);
    expect(put).toEqual([
      { key: 'SET_IN_DASHBOARD', value: 'keep-me' },
      { key: 'DATABASE_URL', value: ENV.DATABASE_URL },
      { key: 'JWT_SECRET', value: 'jwt-123' },
    ]);
    expect((c.logger as MemoryLogger).lines).toContain('info: Render: added JWT_SECRET; updated DATABASE_URL from .env.production.');
    expect((c.logger as MemoryLogger).lines.join('\n')).not.toContain('jwt-123');
  });

  it('Render: reads every page of existing variables before replacing them', async () => {
    let put: Array<{ key: string }> = [];
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ envVar: { key: `K${from + i}`, value: 'v' }, cursor: `c${from + i}` }));
    server.use(
      ...finished('srv-1', 'dep-2'),
      http.get('https://api.render.com/v1/services/srv-1/env-vars', ({ request }) =>
        HttpResponse.json(new URL(request.url).searchParams.get('cursor') === 'c99' ? page(100, 3) : page(0, 100)),
      ),
      http.put('https://api.render.com/v1/services/srv-1/env-vars', async ({ request }) => {
        put = (await request.json()) as Array<{ key: string }>;
        return HttpResponse.json([]);
      }),
      http.post('https://api.render.com/v1/services/srv-1/deploys', () => HttpResponse.json({ id: 'dep-2', status: 'created' })),
    );
    await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: serverProfile, options: { serviceId: 'srv-1' }, env: { NEW: 'x' } }));
    expect(put).toHaveLength(104);
  });

  it('Render: unchanged variables are not rewritten, and the push auto-deploy is followed', async () => {
    let wrote = false;
    let triggered = false;
    server.use(
      ...finished('srv-1', 'dep-auto'),
      http.get('https://api.render.com/v1/services/srv-1/env-vars', () => HttpResponse.json([{ envVar: { key: 'JWT_SECRET', value: 'jwt-123' }, cursor: 'c' }])),
      http.put('https://api.render.com/v1/services/srv-1/env-vars', () => {
        wrote = true;
        return HttpResponse.json([]);
      }),
      http.get('https://api.render.com/v1/services/srv-1/deploys', () => HttpResponse.json([{ deploy: { id: 'dep-auto', status: 'build_in_progress', commit: { id: 'f00d' } } }])),
      http.post('https://api.render.com/v1/services/srv-1/deploys', () => {
        triggered = true;
        return HttpResponse.json({ id: 'x', status: 'created' });
      }),
    );
    await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: serverProfile, options: { serviceId: 'srv-1' }, env: { JWT_SECRET: 'jwt-123' }, pushedCommit: 'f00d' }));
    expect(wrote).toBe(false);
    expect(triggered).toBe(false);
  });

  it('Render: changed variables → a fresh build of the pushed commit, since the auto-deploy started with the old ones', async () => {
    let body: unknown;
    server.use(
      ...finished('srv-1', 'dep-new'),
      http.get('https://api.render.com/v1/services/srv-1/env-vars', () => HttpResponse.json([])),
      http.put('https://api.render.com/v1/services/srv-1/env-vars', () => HttpResponse.json([])),
      http.get('https://api.render.com/v1/services/srv-1/deploys', () => HttpResponse.json([{ deploy: { id: 'dep-auto', status: 'build_in_progress', commit: { id: 'f00d' } } }])),
      http.post('https://api.render.com/v1/services/srv-1/deploys', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 'dep-new', status: 'created' });
      }),
    );
    const d = await new RenderProvider(httpClient, new FakeGit(), FAST).deploy(ctx({ profile: serverProfile, options: { serviceId: 'srv-1' }, env: ENV, pushedCommit: 'f00d' }));
    expect(body).toEqual({ clearCache: 'do_not_clear', commitId: 'f00d' });
    expect(d.id).toBe('dep-new');
  });

  it('Railway: sets the variables before `railway up`, without an extra deploy', async () => {
    const proc = new FakeProcess(() => ({ stdout: 'ok' }), ['railway']);
    await new RailwayProvider(proc).deploy(ctx({ profile: serverProfile, options: { service: 'api' }, env: ENV }));
    expect(proc.calls[0]).toMatchObject({
      args: ['variable', 'set', `DATABASE_URL=${ENV.DATABASE_URL}`, 'JWT_SECRET=jwt-123', '--skip-deploys', '--service', 'api'],
      env: { RAILWAY_TOKEN: 'tok' },
    });
    expect(proc.calls[1]!.args[0]).toBe('up');
  });

  it('Railway: falls back to the older CLI syntax', async () => {
    const proc = new FakeProcess(
      (_b, args) => (args[0] === 'variable' ? { exitCode: 2, stderr: "error: unrecognized subcommand 'set'" } : { stdout: 'ok' }),
      ['railway'],
    );
    await new RailwayProvider(proc).deploy(ctx({ profile: serverProfile, env: { A: 'one' } }));
    expect(proc.calls[1]!.args).toEqual(['variables', '--set', 'A=one', '--skip-deploys']);
  });

  it('Railway: a failure never shows the values', async () => {
    const proc = new FakeProcess(() => ({ exitCode: 1, stderr: `failed to set DATABASE_URL=${ENV.DATABASE_URL} with tok` }), ['railway']);
    const err = await new RailwayProvider(proc).deploy(ctx({ profile: serverProfile, env: ENV })).catch((e) => e);
    expect(err.message).toContain('could not set environment variables');
    expect(err.message).not.toContain('u:new');
    expect(err.message).toContain('***');
  });

  const nextProfile: ProjectProfile = { rootDir: ROOT, language: 'node', framework: 'nuxt', kind: 'serverless', port: 3000, hasDockerfile: false };
  const nextFs = () => new MemoryFs(new Map([[`${ROOT}/package.json`, '{}'], [`${ROOT}/pages/index.vue`, '<template/>']]));

  it('Vercel (framework app): creates the project if needed, upserts the variables, then deploys into it', async () => {
    const calls: string[] = [];
    let envBody: unknown;
    let deployBody: Record<string, any> = {};
    server.use(
      http.get('https://api.vercel.com/v9/projects/demo', () => (calls.push('get project'), HttpResponse.json({ error: { code: 'not_found' } }, { status: 404 }))),
      http.post('https://api.vercel.com/v11/projects', () => (calls.push('create project'), HttpResponse.json({ id: 'prj_9' }))),
      http.post('https://api.vercel.com/v10/projects/prj_9/env', async ({ request }) => {
        calls.push(`env upsert=${new URL(request.url).searchParams.get('upsert')}`);
        envBody = await request.json();
        return HttpResponse.json({ created: [], failed: [] });
      }),
      http.post('https://api.vercel.com/v13/deployments', async ({ request }) => {
        calls.push('deploy');
        deployBody = (await request.json()) as Record<string, any>;
        return HttpResponse.json({ id: 'dpl_1', url: 'demo.vercel.app', readyState: 'READY', projectId: 'prj_9' });
      }),
      http.get('https://api.vercel.com/v13/deployments/dpl_1', () => HttpResponse.json({ id: 'dpl_1', url: 'demo.vercel.app', readyState: 'READY', projectId: 'prj_9' })),
    );
    await new VercelProvider(httpClient, nextFs(), FAST).deploy(ctx({ profile: nextProfile, sourceDir: ROOT, env: ENV }));
    expect(calls).toEqual(['get project', 'create project', 'env upsert=true', 'deploy']);
    expect(envBody).toEqual([
      { key: 'DATABASE_URL', value: ENV.DATABASE_URL, type: 'encrypted', target: ['production', 'preview'] },
      { key: 'JWT_SECRET', value: 'jwt-123', type: 'encrypted', target: ['production', 'preview'] },
    ]);
    expect(deployBody).toMatchObject({ project: 'prj_9', projectSettings: { framework: 'nuxtjs' } });
  });

  it('Vercel: reports variables it could not set', async () => {
    server.use(
      http.post('https://api.vercel.com/v10/projects/prj_1/env', () => HttpResponse.json({ failed: [{ error: { key: 'BAD-NAME', message: 'invalid key' } }] })),
    );
    const err = await new VercelProvider(httpClient, nextFs(), FAST)
      .deploy(ctx({ profile: nextProfile, sourceDir: ROOT, env: { 'BAD-NAME': 'x' }, options: { projectId: 'prj_1' } }))
      .catch((e) => e);
    expect(err.message).toBe('Vercel API error: could not set environment variables (BAD-NAME: invalid key)');
  });

  it('Vercel static sites: nothing is sent — the local build already used the values', async () => {
    server.use(
      http.post('https://api.vercel.com/v13/deployments', () => HttpResponse.json({ id: 'dpl_1', url: 'demo.vercel.app', readyState: 'READY' })),
      http.get('https://api.vercel.com/v13/deployments/dpl_1', () => HttpResponse.json({ id: 'dpl_1', url: 'demo.vercel.app', readyState: 'READY' })),
    );
    await expect(new VercelProvider(httpClient, siteFs(), FAST).deploy(ctx({ env: ENV }))).resolves.toBeTruthy(); // msw fails on any other request
  });
});
