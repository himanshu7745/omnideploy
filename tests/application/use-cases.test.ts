import { beforeEach, describe, expect, it } from 'vitest';
import {
  BuildProject,
  CredentialResolver,
  DeployProject,
  DetectProject,
  GenerateArtifacts,
  InitProject,
  LoginProvider,
  LogoutProvider,
  ProviderRegistry,
  RepositoryBootstrapper,
  SecretGuard,
  ProductionEnvironment,
} from '../../src/application/index.js';
import {
  DomainError,
  IncompatibleProviderError,
  MissingCredentialError,
  RepoAccessError,
  type ArtifactGenerator,
  type DeployContext,
  type DeploymentProvider,
  type ProjectDetector,
  type ProjectProfile,
  type ProviderCapabilities,
} from '../../src/domain/index.js';
import { FakeBrowser, FakeGit, FakeProcess, FakePrompt, FakeRepoHost, MemoryConfigRepo, MemoryCredentials, MemoryFs, MemoryLogger } from '../helpers/fakes.js';

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
  /** Number of deploy attempts that fail with RepoAccessError before succeeding. */
  noRepoAccess = 0;
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
    if (this.noRepoAccess-- > 0) throw new RepoAccessError(this.displayName, 'https://github.com/me/demo', 'https://github.com/apps/render/installations/new', 'grant it');
    return { provider: this.id, id: 'd1', url: `https://${ctx.serviceName}.${this.id}.test`, state: 'ready' as const, configUpdates: { siteId: 'site-1' } };
  }
}

const auth = (id: string) => ({ envVar: `${id.toUpperCase()}_TOKEN`, tokenUrl: `https://${id}.test/tokens` });

function setup(opts: {
  profile: Partial<ProjectProfile> | null;
  tokens?: Record<string, string>;
  prompt?: FakePrompt;
  config?: MemoryConfigRepo;
  git?: FakeGit;
  repoHost?: FakeRepoHost;
}) {
  const fs = new MemoryFs(new Map([[`${ROOT}/dist/index.html`, '<h1>hi</h1>']]));
  const logger = new MemoryLogger();
  const prompt = opts.prompt ?? new FakePrompt(false);
  const configRepo = opts.config ?? new MemoryConfigRepo();
  const git = opts.git ?? new FakeGit();
  const proc = new FakeProcess();
  const staticHost = new StubProvider('netlify', 'Netlify', { kinds: ['static'], serverLanguages: [], previews: true, buildsFromGit: false, auth: auth('netlify') }, ['netlify-toml']);
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
  const credentials = new CredentialResolver(new MemoryCredentials(opts.tokens ?? { netlify: 't-n', render: 't-r', railway: 't-rw' }), prompt);
  const repoHost = opts.repoHost ?? new FakeRepoHost('gh-cli-token');
  const browser = new FakeBrowser();
  const secrets = new SecretGuard(fs, prompt, logger);
  const deploy = new DeployProject(
    detect,
    registry,
    generate,
    new BuildProject(proc, fs, logger),
    credentials,
    configRepo,
    git,
    new RepositoryBootstrapper(git, repoHost, fs, credentials, prompt, logger, secrets),
    prompt,
    logger,
    browser,
    secrets,
    new ProductionEnvironment(fs, prompt, logger, secrets),
  );
  const init = new InitProject(detect, registry, generate, configRepo, prompt, logger);
  return { fs, logger, prompt, configRepo, git, repoHost, browser, proc, staticHost, gitHost, containerHost, deploy, init, generate };
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

  it('creates a private GitHub repo, commits and pushes when there is no git repository (--yes)', async () => {
    const git = new FakeGit(null, ['src/Main.java', 'pom.xml']);
    const s = setup({ profile: JAVA, git });
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true });

    expect(s.fs.files.get(`${ROOT}/.gitignore`)).toContain('.env');
    expect(git.inited).toEqual(['main']);
    expect(git.commits[0]).toEqual({ paths: ['src/Main.java', 'pom.xml'], message: 'Initial commit (omnideploy)' });
    expect(s.repoHost.created).toEqual([{ token: 'gh-cli-token', name: 'demo-api', private: true }]);
    expect(git.remoteInfo?.url).toBe('https://github.com/me/demo-api.git');
    expect(git.pushAuth).toEqual([{ token: 'gh-cli-token' }]);
    expect(s.gitHost.deployed).toHaveLength(1);
  });

  it("tries to give the provider's git app access to the new repo, and carries on quietly if it cannot", async () => {
    const s = setup({ profile: JAVA, git: new FakeGit(null, ['pom.xml']), repoHost: new FakeRepoHost('t', 'unavailable') });
    s.gitHost.capabilities.gitHostApps = { github: 'render' };
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true });
    expect(s.repoHost.grants).toEqual(['render:me/demo-api']);
    expect(s.logger.lines.some((l) => l.startsWith('warn:'))).toBe(false);
    expect(s.gitHost.deployed).toHaveLength(1);
  });

  it('pushes an existing local repository without a remote, committing generated files first', async () => {
    const git = new FakeGit(null, ['Dockerfile', 'render.yaml'], true);
    const s = setup({ profile: JAVA, git, tokens: { render: 't-r', github: 'stored-gh' } });
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true });

    expect(git.inited).toEqual([]);
    expect(s.fs.files.has(`${ROOT}/.gitignore`)).toBe(false);
    expect(git.commits.map((c) => c.message)).toEqual(['chore: add deployment configuration (omnideploy)']);
    expect(s.repoHost.created[0]!.token).toBe('stored-gh');
    expect(git.pushes).toBe(1);
  });

  it('asks before creating a repository when interactive', async () => {
    const prompt = new FakePrompt(true, { confirm: false });
    const s = setup({ profile: { ...JAVA, hasDockerfile: true }, git: new FakeGit(null), prompt });
    s.fs.files.set(`${ROOT}/Dockerfile`, 'FROM x');
    s.fs.files.set(`${ROOT}/render.yaml`, 'services: []');
    await expect(s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true })).rejects.toThrow(/no git remote/);
    expect(prompt.confirms.some((c) => /Create a private GitHub repository/.test(c))).toBe(true);
    expect(s.repoHost.created).toHaveLength(0);
  });

  it('explains how to proceed without a remote when not interactive and no --yes', async () => {
    const s = setup({ profile: { ...JAVA, hasDockerfile: true }, git: new FakeGit(null) });
    s.fs.files.set(`${ROOT}/Dockerfile`, 'FROM x');
    s.fs.files.set(`${ROOT}/render.yaml`, 'services: []');
    const err = await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true }).catch((e) => e);
    expect(err.code).toBe('NO_GIT_REMOTE');
    expect(err.hint).toMatch(/--yes/);
  });

  it('never puts secret files in the initial commit of a new repo', async () => {
    const git = new FakeGit(null, ['app.py', '.env', '.env.example', 'certs/server.key']);
    const s = setup({ profile: JAVA, git });
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true });
    expect(git.commits[0]).toEqual({ paths: ['app.py', '.env.example'], message: 'Initial commit (omnideploy)' });
    expect(s.fs.files.get(`${ROOT}/.gitignore`)).toMatch(/^\.env$/m);
    expect(s.fs.files.get(`${ROOT}/.gitignore`)).toContain('certs/server.key');
  });

  it('leaves files with hard-coded secrets out of the initial commit (--yes)', async () => {
    const git = new FakeGit(null, ['pom.xml', 'src/main/resources/application.yml']);
    const s = setup({ profile: JAVA, git });
    s.fs.files.set(`${ROOT}/src/main/resources/application.yml`, 'spring:\n  datasource:\n    password: S3cretPass!\n');
    s.fs.files.set(`${ROOT}/pom.xml`, '<project/>');
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true });
    expect(git.commits[0]!.paths).toEqual(['pom.xml']);
    expect(s.prompt.notes.find((n) => n.title === 'Possible hard-coded secrets')?.body).toContain('line 3: password (S3•••s!)');
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

describe('DeployProject edge cases', () => {
  it('--preview on a provider without previews fails before touching anything', async () => {
    const s = setup({ profile: JAVA });
    const err = await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: false, yes: true }).catch((e) => e);
    expect(err.code).toBe('PREVIEW_UNSUPPORTED');
    expect(err.hint).toBe('Drop --preview to deploy to production.');
    expect(s.fs.files.has(`${ROOT}/Dockerfile`)).toBe(false);
    expect(s.gitHost.deployed).toHaveLength(0);
  });

  it('--preview suggests a provider that has previews', async () => {
    const s = setup({ profile: VITE });
    const err = await s.deploy.execute({ rootDir: ROOT, providerIds: ['railway'], production: false, yes: true }).catch((e) => e);
    expect(err.hint).toBe('Drop --preview to deploy to production, or preview on Netlify.');
  });

  it('tells git-based providers which commit it pushed', async () => {
    const git = new FakeGit(undefined, ['src/App.java']);
    git.head = 'f00dcafe';
    const s = setup({ profile: { ...JAVA, hasDockerfile: true }, git });
    s.fs.files.set(`${ROOT}/Dockerfile`, 'FROM x');
    s.fs.files.set(`${ROOT}/render.yaml`, 'services: []');
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true });
    expect(s.gitHost.deployed[0]!.pushedCommit).toBe('f00dcafe');
  });

  it('does not claim a push when the remote was already up to date', async () => {
    const s = setup({ profile: { ...JAVA, hasDockerfile: true } });
    s.fs.files.set(`${ROOT}/Dockerfile`, 'FROM x');
    s.fs.files.set(`${ROOT}/render.yaml`, 'services: []');
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true });
    expect(s.gitHost.deployed[0]!.pushedCommit).toBeUndefined();
  });

  it('refuses to upload an empty build output folder', async () => {
    const s = setup({ profile: { ...VITE, buildCommand: undefined, outputDir: 'out' } });
    s.fs.files.set(`${ROOT}/out`, ''); // an existing but empty directory
    const err = await s.deploy.execute({ rootDir: ROOT, providerIds: ['netlify'], production: true, yes: true }).catch((e) => e);
    expect(err.code).toBe('EMPTY_OUTPUT');
    expect(s.staticHost.deployed).toHaveLength(0);
  });
});

describe('DeployProject git sync (redeploys)', () => {
  const RENDER = { ...JAVA, hasDockerfile: true };
  const withFiles = (git: FakeGit, prompt: FakePrompt) => {
    const s = setup({ profile: RENDER, git, prompt });
    s.fs.files.set(`${ROOT}/Dockerfile`, 'FROM x');
    s.fs.files.set(`${ROOT}/render.yaml`, 'services: []');
    return s;
  };
  const run = (s: ReturnType<typeof setup>, yes = false) => s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes });

  it('commits and pushes code changes too, by default', async () => {
    const git = new FakeGit(undefined, ['render.yaml', 'src/App.java', 'pom.xml']);
    const s = withFiles(git, new FakePrompt(true, { select: 'all' }));
    await run(s);
    expect(git.commits).toEqual([{ paths: ['render.yaml', 'src/App.java', 'pom.xml'], message: 'Deploy with omnideploy' }]);
    expect(git.pushes).toBe(1);
    expect(s.prompt.notes.some((n) => n.title === '3 uncommitted change(s)')).toBe(true);
  });

  it('can commit only the deployment files', async () => {
    const git = new FakeGit(undefined, ['render.yaml', 'src/App.java']);
    await run(withFiles(git, new FakePrompt(true, { select: 'deploy-files' })));
    expect(git.commits).toEqual([{ paths: ['render.yaml'], message: 'chore: add deployment configuration (omnideploy)' }]);
    expect(git.pushes).toBe(1);
  });

  it('can deploy the last pushed commit without pushing', async () => {
    const git = new FakeGit(undefined, ['src/App.java']);
    const s = withFiles(git, new FakePrompt(true, { select: 'none' }));
    await run(s);
    expect(git.commits).toEqual([]);
    expect(git.pushes).toBe(0);
    expect(s.gitHost.deployed).toHaveLength(1);
  });

  it('pushes local commits that were never pushed', async () => {
    const git = new FakeGit(undefined, []);
    git.unpushed = 2;
    const s = withFiles(git, new FakePrompt(true, { confirm: true }));
    await run(s);
    expect(s.prompt.confirms).toContain('Render builds from your git remote. Push 2 local commit(s) so it gets deployed?');
    expect(git.pushes).toBe(1);
  });

  it('does nothing when the remote is already up to date', async () => {
    const git = new FakeGit(undefined, []);
    const s = withFiles(git, new FakePrompt(true));
    await run(s);
    expect(git.pushes).toBe(0);
    expect(s.prompt.confirms).toEqual([]);
  });

  it('--yes commits everything except secret files, which go to .gitignore', async () => {
    const git = new FakeGit(undefined, ['src/App.java', '.env', 'config/server.key', '.env.example']);
    const s = withFiles(git, new FakePrompt(false));
    await run(s, true);
    expect(git.commits[0]!.paths).toEqual(['src/App.java', '.env.example', '.gitignore']);
    expect(s.fs.files.get(`${ROOT}/.gitignore`)).toBe('# Secrets (added by omnideploy)\n.env\nconfig/server.key\n');
    expect(s.logger.lines).toContain('info: Added .env, config/server.key to .gitignore — they stay on your machine only.');
  });

  it('interactive: asks before touching .gitignore, and still never commits the secret file', async () => {
    const git = new FakeGit(undefined, ['src/App.java', '.env']);
    const s = withFiles(git, new FakePrompt(true, { select: 'all', confirm: false }));
    s.fs.files.set(`${ROOT}/.gitignore`, 'target/\n');
    await run(s);
    expect(s.prompt.confirms.some((c) => c.startsWith('.env looks like secrets'))).toBe(true);
    expect(git.commits[0]!.paths).toEqual(['src/App.java']);
    expect(s.fs.files.get(`${ROOT}/.gitignore`)).toBe('target/\n');
  });

  it('hard-coded secret in application.yml: the user can leave the file out', async () => {
    const git = new FakeGit(undefined, ['src/App.java', 'src/main/resources/application.yml']);
    const s = withFiles(git, new FakePrompt(true, { select: ['all', 'exclude'] }));
    s.fs.files.set(`${ROOT}/src/main/resources/application.yml`, 'jwt:\n  secret: c2VjcmV0LWtleS0xMjM0\n');
    await run(s);
    expect(s.prompt.selects[1]).toMatch(/look like secrets/);
    expect(git.commits[0]!.paths).toEqual(['src/App.java']);
    expect(s.logger.lines.some((l) => l.includes('Left out src/main/resources/application.yml'))).toBe(true);
  });

  it('hard-coded secret in application.yml: the user can commit it anyway', async () => {
    const git = new FakeGit(undefined, ['src/main/resources/application.yml']);
    const s = withFiles(git, new FakePrompt(true, { select: ['all', 'commit'] }));
    s.fs.files.set(`${ROOT}/src/main/resources/application.yml`, 'password: hunter22\n');
    await run(s);
    expect(git.commits[0]!.paths).toEqual(['src/main/resources/application.yml']);
  });

  it('config that reads secrets from the environment is committed without questions', async () => {
    const git = new FakeGit(undefined, ['src/main/resources/application.yml']);
    const s = withFiles(git, new FakePrompt(true, { select: 'all' }));
    s.fs.files.set(`${ROOT}/src/main/resources/application.yml`, 'spring:\n  datasource:\n    password: ${DB_PASSWORD}\n');
    s.fs.files.set(`${ROOT}/.env.production`, 'DB_PASSWORD=from-the-env-file\n');
    await run(s);
    expect(s.prompt.selects).toHaveLength(1);
    expect(git.commits[0]!.paths).toEqual(['src/main/resources/application.yml']);
  });

  it('warns when a secret file is already committed', async () => {
    const git = new FakeGit(undefined, []);
    git.tracked = ['pom.xml', '.env'];
    const s = withFiles(git, new FakePrompt(true));
    await run(s);
    expect(s.logger.lines.some((l) => l.startsWith('warn: .env is committed to git') && l.includes('git rm --cached .env'))).toBe(true);
  });

  it('explains a rejected push', async () => {
    const git = new FakeGit(undefined, ['src/App.java']);
    git.pushError = new DomainError('git push failed: ! [rejected] main -> main (fetch first)');
    const err = await run(withFiles(git, new FakePrompt(false)), true).catch((e) => e);
    expect(err.code).toBe('GIT_PUSH_REJECTED');
    expect(err.hint).toMatch(/git pull --rebase/);
  });

  it('non-interactive without --yes says how to proceed', async () => {
    const err = await run(withFiles(new FakeGit(undefined, ['src/App.java']), new FakePrompt(false))).catch((e) => e);
    expect(err.code).toBe('GIT_SYNC_REQUIRED');
    expect(err.hint).toMatch(/--yes/);
  });
});

describe('.env.production (single source of truth for production variables)', () => {
  const RENDER = { ...JAVA, hasDockerfile: true };
  const ready = (opts: { prompt?: FakePrompt; config?: MemoryConfigRepo; profile?: Partial<ProjectProfile> } = {}) => {
    const s = setup({ profile: opts.profile ?? RENDER, prompt: opts.prompt, config: opts.config });
    s.fs.files.set(`${ROOT}/Dockerfile`, 'FROM x');
    s.fs.files.set(`${ROOT}/render.yaml`, 'services: []');
    return s;
  };
  const deployRender = (s: ReturnType<typeof setup>, extra: { yes?: boolean; dryRun?: boolean } = { yes: true }) =>
    s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, ...extra });

  it('no .env.production and nothing expected: deploys with no variables', async () => {
    const s = ready();
    await deployRender(s);
    expect(s.gitHost.deployed[0]!.env).toEqual({});
  });

  it('passes every variable to the provider, except PORT (the platform sets it)', async () => {
    const s = ready();
    s.fs.files.set(`${ROOT}/.env.production`, 'DATABASE_URL=postgres://u:p@db.example.com/app\nJWT_SECRET="s3cr3t value"\nPORT=3000\n');
    await deployRender(s);
    expect(s.gitHost.deployed[0]!.env).toEqual({ DATABASE_URL: 'postgres://u:p@db.example.com/app', JWT_SECRET: 's3cr3t value' });
    expect(s.logger.lines).toContain('info: Ignoring PORT from .env.production: the platform sets it.');
    expect(s.logger.lines.join('\n')).not.toContain('s3cr3t');
  });

  it('passes the variables to local static builds', async () => {
    const s = setup({ profile: VITE });
    s.fs.files.set(`${ROOT}/.env.production`, 'VITE_API_URL=https://api.example.com\n');
    await s.deploy.execute({ rootDir: ROOT, providerIds: ['netlify'], production: true, yes: true });
    expect(s.proc.calls[0]!.env).toMatchObject({ CI: '1', VITE_API_URL: 'https://api.example.com' });
  });

  it('missing file but the app expects variables: stops before doing anything (non-interactive)', async () => {
    const s = ready();
    s.fs.files.set(`${ROOT}/.env.example`, 'DATABASE_URL=\nJWT_SECRET=changeme\nPORT=8080\n');
    s.fs.files.delete(`${ROOT}/Dockerfile`);
    const err = await deployRender(s).catch((e) => e);
    expect(err.code).toBe('ENV_INCOMPLETE');
    expect(err.message).toBe(
      'The app needs production environment variables, but there is no .env.production for DATABASE_URL, JWT_SECRET (the app expects them, see .env.example).',
    );
    expect(err.hint).toMatch(/Put the production values in \.env\.production/);
    expect(s.fs.files.has(`${ROOT}/Dockerfile`)).toBe(false); // nothing generated
    expect(s.gitHost.deployed).toHaveLength(0);
  });

  it('interactive: offers to create .env.production with the expected names, then stops so you can fill it in', async () => {
    const prompt = new FakePrompt(true, { confirm: true });
    const s = ready({ prompt });
    s.fs.files.set(`${ROOT}/.env.example`, 'DATABASE_URL=\nJWT_SECRET=\n');
    const err = await deployRender(s, {}).catch((e) => e);
    expect(prompt.confirms).toContain('Create .env.production with DATABASE_URL, JWT_SECRET for you to fill in?');
    expect(err.message).toBe('Created .env.production — fill in DATABASE_URL, JWT_SECRET, then deploy again.');
    expect(s.fs.files.get(`${ROOT}/.env.production`)).toMatch(/^# Production environment variables[\s\S]*\nDATABASE_URL=\nJWT_SECRET=\n$/);
    expect(s.fs.files.get(`${ROOT}/.gitignore`)).toContain('.env.production');
    expect(s.gitHost.deployed).toHaveLength(0);
  });

  it('Spring: ${VAR} placeholders without a default are required; with a default they are not', async () => {
    const s = ready();
    s.fs.files.set(`${ROOT}/src/main/resources/application.yml`, 'spring:\n  datasource:\n    password: ${DB_PASSWORD}\n    username: ${DB_USER:app}\n');
    s.fs.files.set(`${ROOT}/.env.production`, 'OTHER=1\n');
    const err = await deployRender(s).catch((e) => e);
    expect(err.message).toContain('.env.production is missing DB_PASSWORD (the app expects it, see src/main/resources/application.yml)');
  });

  it('empty values count as missing', async () => {
    const s = ready();
    s.fs.files.set(`${ROOT}/.env.production`, 'DATABASE_URL=postgres://u:p@db.example.com/app\nJWT_SECRET=\n');
    const err = await deployRender(s).catch((e) => e);
    expect(err.message).toBe('The app needs production environment variables, but JWT_SECRET is empty in .env.production.');
  });

  it('env.optional allows a variable to be missing or empty', async () => {
    const s = ready({ config: new MemoryConfigRepo({ env: { optional: ['SENTRY_DSN', 'JWT_SECRET'] }, providers: {} }) });
    s.fs.files.set(`${ROOT}/.env.example`, 'DATABASE_URL=\nSENTRY_DSN=\n');
    s.fs.files.set(`${ROOT}/.env.production`, 'DATABASE_URL=postgres://db.example.com/app\nJWT_SECRET=\n');
    await deployRender(s);
    expect(s.gitHost.deployed[0]!.env).toEqual({ DATABASE_URL: 'postgres://db.example.com/app' });
  });

  it('env.sync = false turns the whole feature off', async () => {
    const s = ready({ config: new MemoryConfigRepo({ env: { sync: false }, providers: {} }) });
    s.fs.files.set(`${ROOT}/.env.example`, 'DATABASE_URL=\n');
    s.fs.files.set(`${ROOT}/.env.production`, 'A=1\n');
    await deployRender(s);
    expect(s.gitHost.deployed[0]!.env).toEqual({});
  });

  it('warns about values that point to localhost', async () => {
    const s = ready();
    s.fs.files.set(`${ROOT}/.env.production`, 'DATABASE_URL=postgres://u:p@localhost:5432/app\n');
    await deployRender(s);
    expect(s.logger.lines.some((l) => l.startsWith('warn: DATABASE_URL in .env.production points to localhost'))).toBe(true);
  });

  it('dry run reports a missing file as a warning instead of failing', async () => {
    const s = ready();
    s.fs.files.set(`${ROOT}/.env.example`, 'DATABASE_URL=\n');
    const report = await deployRender(s, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(s.logger.lines.some((l) => l.startsWith('warn: The app needs production environment variables'))).toBe(true);
  });
});

describe('DeployProject repository access', () => {
  const ready = (prompt: FakePrompt) => {
    const s = setup({ profile: { ...JAVA, hasDockerfile: true }, prompt });
    s.fs.files.set(`${ROOT}/Dockerfile`, 'FROM x');
    s.fs.files.set(`${ROOT}/render.yaml`, 'services: []');
    s.gitHost.noRepoAccess = 1;
    return s;
  };

  it('yes: opens the grant page, waits, and retries the deploy', async () => {
    const prompt = new FakePrompt(true, { confirm: true });
    const s = ready(prompt);
    const report = await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true });
    expect(prompt.confirms).toContain('Render needs access to me/demo. Open the page to grant it and continue deploying?');
    expect(s.browser.opened).toEqual(['https://github.com/apps/render/installations/new']);
    expect(s.gitHost.deployed).toHaveLength(2);
    expect(report.outcomes[0]!.ok).toBe(true);
  });

  it('no: does not deploy', async () => {
    const prompt = new FakePrompt(true, { confirm: false });
    const s = ready(prompt);
    const report = await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, force: false }).catch((e) => e);
    // confirm=false also declines writing files, so files are pre-created; the deploy outcome is a cancellation.
    expect(s.browser.opened).toEqual([]);
    expect(s.gitHost.deployed).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({ ok: false, error: expect.objectContaining({ message: 'Deployment to Render cancelled.' }) });
  });

  it('--yes / CI: never prompts, reports the access error with its hint', async () => {
    const s = ready(new FakePrompt(true));
    const report = await s.deploy.execute({ rootDir: ROOT, providerIds: ['render'], production: true, yes: true });
    expect(s.browser.opened).toEqual([]);
    expect(report.outcomes[0]!.error).toBeInstanceOf(RepoAccessError);
  });
});

describe('LoginProvider / LogoutProvider', () => {
  const github = { id: 'github', displayName: 'GitHub', auth: { envVar: 'GITHUB_TOKEN', tokenUrl: 'https://github.test' } };
  const registry = () => new ProviderRegistry([]);

  it('saves, replaces and removes the github repository-host token', async () => {
    const store = new MemoryCredentials();
    const login = new LoginProvider(registry(), store, new FakePrompt(false), [github]);
    await login.execute('github', 'old');
    await login.execute('github', ' new ');
    expect(store.tokens.github).toBe('new');
    expect(await new LogoutProvider(registry(), store, [github]).execute('github')).toEqual({ subject: github, removed: true });
    expect(store.tokens.github).toBeUndefined();
  });

  it('lists github among known ids for an unknown one', async () => {
    const err = await new LogoutProvider(registry(), new MemoryCredentials(), [github]).execute('gitlab').catch((e) => e);
    expect(err.hint).toMatch(/github/);
  });
});
