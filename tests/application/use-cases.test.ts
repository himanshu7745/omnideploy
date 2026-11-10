import { beforeEach, describe, expect, it } from 'vitest';
import {
  BuildProject,
  CredentialResolver,
  DeployProject,
  DetectProject,
  GenerateArtifacts,
  InitProject,
  ProviderRegistry,
} from '../../src/application/index.js';
import {
  DomainError,
  IncompatibleProviderError,
  MissingCredentialError,
  type ArtifactGenerator,
  type DeployContext,
  type DeploymentProvider,
  type ProjectDetector,
  type ProjectProfile,
  type ProviderCapabilities,
} from '../../src/domain/index.js';
import { FakeGit, FakeProcess, FakePrompt, MemoryConfigRepo, MemoryCredentials, MemoryFs, MemoryLogger } from '../helpers/fakes.js';

const ROOT = '/work/app';

class StubDetector implements ProjectDetector {
  readonly id = 'stub';
  constructor(private readonly profile: Partial<ProjectProfile> | null) {}
  async detect(rootDir: string) {
    return this.profile ? { profile: { rootDir, language: 'node', kind: 'server', port: 3000, hasDockerfile: false, ...this.profile } as ProjectProfile, confidence: 50 } : null;
  }
}

class StubGenerator implements ArtifactGenerator {
  constructor(
    readonly id: string,
    readonly path: string,
  ) {}
  supports(p: ProjectProfile) {
    return p.language !== 'docker';
  }
  generate(p: ProjectProfile) {
    return { id: this.id, path: this.path, contents: `${this.id} for ${p.language}`, description: this.id };
  }
}

class StubProvider implements DeploymentProvider {
  deployed: DeployContext[] = [];
  fail = false;
  constructor(
    readonly id: string,
    readonly displayName: string,
    readonly capabilities: ProviderCapabilities,
    private readonly artifacts: string[] = [],
  ) {}
  requiredArtifacts() {
    return this.artifacts;
  }
  async validate() {}
  async deploy(ctx: DeployContext) {
    this.deployed.push(ctx);
    if (this.fail) throw new DomainError('boom');
    return { provider: this.id, id: 'd1', url: `https://${ctx.serviceName}.${this.id}.test`, state: 'ready' as const, configUpdates: { siteId: 'site-1' } };
  }
}

const auth = (id: string) => ({ envVar: `${id.toUpperCase()}_TOKEN`, tokenUrl: `https://${id}.test/tokens` });

function setup(opts: { profile: Partial<ProjectProfile> | null; tokens?: Record<string, string>; prompt?: FakePrompt; config?: MemoryConfigRepo; git?: FakeGit }) {
  const fs = new MemoryFs(new Map([[`${ROOT}/dist/index.html`, '<h1>hi</h1>']]));
  const logger = new MemoryLogger();
  const prompt = opts.prompt ?? new FakePrompt(false);
  const configRepo = opts.config ?? new MemoryConfigRepo();
  const git = opts.git ?? new FakeGit();
  const proc = new FakeProcess();
  const staticHost = new StubProvider('netlify', 'Netlify', { kinds: ['static'], serverLanguages: [], buildsFromGit: false, auth: auth('netlify') }, ['netlify-toml']);
  const gitHost = new StubProvider(
    'render',
    'Render',
    { kinds: ['static', 'server'], serverLanguages: 'any', buildsFromGit: true, auth: auth('render') },
    ['dockerfile', 'render-yaml'],
  );
  const containerHost = new StubProvider('railway', 'Railway', { kinds: ['static', 'server'], serverLanguages: 'any', buildsFromGit: false, auth: auth('railway') }, ['dockerfile']);
  const registry = new ProviderRegistry([staticHost, gitHost, containerHost]);
  const generators = [new StubGenerator('dockerfile', 'Dockerfile'), new StubGenerator('render-yaml', 'render.yaml'), new StubGenerator('netlify-toml', 'netlify.toml')];

  const detect = new DetectProject([new StubDetector(opts.profile)], configRepo);
  const generate = new GenerateArtifacts(generators, registry, fs, prompt, logger);
  const deploy = new DeployProject(
    detect,
    registry,
    generate,
    new BuildProject(proc, fs, logger),
    new CredentialResolver(new MemoryCredentials(opts.tokens ?? { netlify: 't-n', render: 't-r', railway: 't-rw' }), prompt),
    configRepo,
    git,
    prompt,
    logger,
  );
  const init = new InitProject(detect, registry, generate, configRepo, prompt, logger);
  return { fs, logger, prompt, configRepo, git, proc, staticHost, gitHost, containerHost, deploy, init, generate };
}

const JAVA: Partial<ProjectProfile> = { language: 'java', framework: 'spring-boot', kind: 'server', port: 8080, meta: { name: 'demo-api' } };
const VITE: Partial<ProjectProfile> = { language: 'node', framework: 'vite-react', kind: 'static', buildCommand: 'npm run build', outputDir: 'dist' };

describe('DeployProject', () => {
  it('Java → Render: generates Dockerfile + render.yaml, pushes them, deploys from the repo root', async () => {
    const git = new FakeGit(undefined, ['Dockerfile', 'render.yaml']);
    const s = setup({ profile: JAVA, git });

    const report = await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true });

    expect(s.fs.files.get(`${ROOT}/Dockerfile`)).toBe('dockerfile for java');
    expect(s.fs.files.get(`${ROOT}/render.yaml`)).toBe('render-yaml for java');
    expect(git.commits).toEqual([{ paths: ['Dockerfile', 'render.yaml'], message: 'chore: add deployment configuration (omnideploy)' }]);
    expect(git.pushes).toBe(1);
    expect(s.gitHost.deployed[0]).toMatchObject({ sourceDir: ROOT, token: 't-r', serviceName: 'demo-api', production: true });
    expect(s.gitHost.deployed[0]!.profile.hasDockerfile).toBe(true);
    expect(report.outcomes).toEqual([expect.objectContaining({ provider: 'render', ok: true })]);
    expect(s.configRepo.config?.providers.render).toEqual({ siteId: 'site-1' });
  });

  it('does not overwrite an existing Dockerfile', async () => {
    const s = setup({ profile: { ...JAVA, hasDockerfile: true } });
    s.fs.files.set(`${ROOT}/Dockerfile`, 'FROM my-custom-image');
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['railway'], production: true, yes: true });
    expect(s.fs.files.get(`${ROOT}/Dockerfile`)).toBe('FROM my-custom-image');
  });

  it('rejects incompatible providers before doing any work, suggesting alternatives', async () => {
    const s = setup({ profile: JAVA });
    const err = await s.deploy.execute({ rootDir: ROOT, providerIds: ['netlify'], production: true, yes: true }).catch((e) => e);
    expect(err).toBeInstanceOf(IncompatibleProviderError);
    expect(err.hint).toBe('Deploy to Render or Railway instead.');
    expect(s.fs.files.has(`${ROOT}/Dockerfile`)).toBe(false);
  });

  it('builds static sites locally and uploads the output directory', async () => {
    const s = setup({ profile: VITE });
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['netlify'], production: false, yes: true });
    expect(s.proc.calls[0]).toMatchObject({ bin: 'sh', args: ['-c', 'npm run build'] });
    expect(s.staticHost.deployed[0]).toMatchObject({ sourceDir: `${ROOT}/dist`, production: false });
  });

  it('skips the build with --no-build', async () => {
    const s = setup({ profile: VITE });
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['netlify'], production: true, skipBuild: true, yes: true });
    expect(s.proc.calls).toHaveLength(0);
  });

  it('fails clearly when credentials are missing in non-interactive mode', async () => {
    const s = setup({ profile: VITE, tokens: {} });
    await expect(s.deploy.execute({ rootDir: ROOT, providerIds: ['netlify'], production: true, yes: true })).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it('asks for a token inline when interactive and saves it', async () => {
    const prompt = new FakePrompt(true, { password: 'pasted-token' });
    const s = setup({ profile: VITE, tokens: {}, prompt });
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['netlify'], production: true });
    expect(s.staticHost.deployed[0]!.token).toBe('pasted-token');
  });

  it('keeps going when one provider fails and reports both outcomes', async () => {
    const s = setup({ profile: VITE });
    s.staticHost.fail = true;
    const report = await s.deploy.execute({ rootDir: ROOT, providerIds: ['netlify', 'railway'], production: true, yes: true });
    expect(report.outcomes.map((o) => [o.provider, o.ok])).toEqual([
      ['netlify', false],
      ['railway', true],
    ]);
  });

  it('requires a git remote for git-based providers', async () => {
    const s = setup({ profile: JAVA, git: new FakeGit(null) });
    await expect(s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true })).rejects.toThrow(/no git remote/);
  });

  it('dry run plans without writing, building or deploying', async () => {
    const s = setup({ profile: JAVA });
    const report = await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(s.fs.files.has(`${ROOT}/Dockerfile`)).toBe(false);
    expect(s.gitHost.deployed).toHaveLength(0);
    expect(s.prompt.notes[0]?.title).toBe('Would generate');
  });

  it('defaults to the providers listed in omnideploy.json', async () => {
    const s = setup({ profile: VITE, config: new MemoryConfigRepo({ providers: { netlify: { siteId: 'abc' } } }) });
    await s.deploy.execute({ rootDir: ROOT, production: true, yes: true });
    expect(s.staticHost.deployed[0]!.options).toEqual({ siteId: 'abc' });
  });

  it('refuses to write files without --yes when not interactive', async () => {
    const s = setup({ profile: JAVA });
    await expect(s.deploy.execute({ rootDir: ROOT, providerIds: ['railway'], production: true })).rejects.toThrow(/not interactive/);
  });
});

describe('InitProject', () => {
  it('offers only compatible providers and writes config + artifacts', async () => {
    const s = setup({ profile: JAVA });
    const result = await s.init.execute({ rootDir: ROOT, yes: true });
    expect(result.providerIds).toEqual(['render', 'railway']);
    expect(s.configRepo.config).toMatchObject({ name: 'demo-api', app: { port: 8080 }, providers: { render: {}, railway: {} } });
    expect(result.written.sort()).toEqual(['Dockerfile', 'render.yaml']);
  });

  it('warns about and drops explicitly requested incompatible providers', async () => {
    const s = setup({ profile: JAVA });
    const result = await s.init.execute({ rootDir: ROOT, providerIds: ['netlify', 'railway'], yes: true });
    expect(result.providerIds).toEqual(['railway']);
    expect(s.logger.lines.some((l) => l.includes('Netlify only hosts static sites'))).toBe(true);
  });
});

describe('GenerateArtifacts', () => {
  it('dedupes artifacts shared by several providers', async () => {
    const s = setup({ profile: JAVA });
    const planned = await s.generate.plan({ profile: { rootDir: ROOT, ...JAVA } as ProjectProfile, config: null, providerIds: ['render', 'railway'] });
    expect(planned.map((a) => [a.path, a.providers])).toEqual([
      ['Dockerfile', ['render', 'railway']],
      ['render.yaml', ['render']],
    ]);
  });

  it('explains when no template exists and no file is present', async () => {
    const s = setup({ profile: { language: 'docker' } });
    await expect(
      s.generate.plan({ profile: { rootDir: ROOT, language: 'docker', kind: 'server', port: 80, hasDockerfile: false }, config: null, providerIds: ['railway'] }),
    ).rejects.toThrow(/no template/);
  });
});
