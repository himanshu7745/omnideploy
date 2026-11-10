import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeployContext, ProjectProfile } from '../../src/domain/index.js';
import { FetchHttpClient } from '../../src/infrastructure/http/FetchHttpClient.js';
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
