import {
  DomainError,
  GitError,
  isSinglePageApp,
  type DeployContext,
  type Deployment,
  type DeploymentProvider,
  type DeploymentStatus,
  type FileSystemPort,
  type GitPort,
  type HttpClientPort,
  type ProjectProfile,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderOptions,
} from '../../domain/index.js';
import { DEFAULT_POLL, poll, redact, type PollOptions } from './support.js';

const API = 'https://api.github.com';

interface PagesInfo {
  html_url?: string;
  source?: { branch: string; path: string };
}
interface PagesBuild {
  status: 'queued' | 'building' | 'built' | 'errored';
  error?: { message?: string | null };
  created_at?: string;
  commit?: string;
}

export class GitHubPagesProvider implements DeploymentProvider {
  readonly id = 'github-pages';
  readonly displayName = 'GitHub Pages';
  readonly capabilities: ProviderCapabilities = {
    kinds: ['static'],
    serverLanguages: [],
    buildsFromGit: false,
    auth: { envVar: 'GITHUB_TOKEN', tokenUrl: 'https://github.com/settings/tokens/new?scopes=repo&description=omnideploy' },
  };

  constructor(
    private readonly http: HttpClientPort,
    private readonly fs: FileSystemPort,
    private readonly git: GitPort,
    private readonly pollOpts: PollOptions = { ...DEFAULT_POLL, timeoutMs: 3 * 60_000 },
  ) {}

  requiredArtifacts() {
    return [];
  }

  async validate(ctx: { profile: ProjectProfile; rootDir: string; options: ProviderOptions }): Promise<void> {
    await this.repo(ctx.rootDir, ctx.options);
  }

  async deploy(ctx: DeployContext): Promise<Deployment> {
    const { owner, repo } = await this.repo(ctx.profile.rootDir, ctx.options);
    const branch = (ctx.options.branch as string | undefined) ?? 'gh-pages';
    const cname = ctx.options.cname as string | undefined;
    const userSite = repo.toLowerCase() === `${owner.toLowerCase()}.github.io`;

    if (!cname && !userSite && /^(vite|create-react-app|angular)/.test(ctx.profile.framework ?? '')) {
      ctx.logger.warn(`GitHub Pages serves this site under /${repo}/. If assets 404, set the base path (Vite: base: '/${repo}/', CRA: "homepage").`);
    }

    ctx.progress('preparing files');
    const tmp = await this.fs.makeTempDir('omnideploy-pages');
    try {
      await this.fs.copyDir(ctx.sourceDir, tmp);
      await this.fs.writeText(this.fs.join(tmp, '.nojekyll'), '');
      if (cname) await this.fs.writeText(this.fs.join(tmp, 'CNAME'), cname + '\n');
      if (isSinglePageApp(ctx.profile)) {
        const index = await this.fs.readTextIfExists(this.fs.join(tmp, 'index.html'));
        if (index && !(await this.fs.exists(this.fs.join(tmp, '404.html')))) await this.fs.writeText(this.fs.join(tmp, '404.html'), index);
      }

      ctx.progress(`pushing to ${branch}`);
      const remoteUrl = `https://x-access-token:${ctx.token}@github.com/${owner}/${repo}.git`;
      try {
        await this.git.publishDirectory(tmp, remoteUrl, branch, `Deploy to GitHub Pages (omnideploy) ${new Date().toISOString()}`);
      } catch (e) {
        throw new GitError(redact(e instanceof Error ? e.message : String(e), ctx.token), 'Check that the token has the "repo" scope and push access.');
      }
    } finally {
      await this.fs.remove(tmp);
    }

    ctx.progress('enabling GitHub Pages');
    const pages = await this.ensurePages(ctx.token, owner, repo, branch);

    ctx.progress('waiting for Pages build');
    const { value: build, timedOut } = await poll(
      () => this.latestBuild(ctx.token, owner, repo),
      (b) => b?.status === 'built' || b?.status === 'errored',
      this.pollOpts,
    );
    if (build?.status === 'errored') {
      throw new DomainError(`GitHub Pages build failed: ${build.error?.message ?? 'unknown error'}`, `See https://github.com/${owner}/${repo}/actions`, 'DEPLOYMENT_FAILED');
    }

    const url = cname ? `https://${cname}/` : (pages.html_url ?? (userSite ? `https://${repo}/` : `https://${owner}.github.io/${repo}/`));
    return {
      provider: this.id,
      id: build?.commit ?? 'latest',
      url,
      state: timedOut || !build ? 'building' : 'ready',
      dashboardUrl: `https://github.com/${owner}/${repo}/settings/pages`,
      configUpdates: { repo: `${owner}/${repo}`, branch },
    };
  }

  async status(ctx: ProviderContext): Promise<DeploymentStatus> {
    const [owner, repo] = String(ctx.options.repo ?? '').split('/');
    if (!owner || !repo) return { id: '-', state: 'unknown', message: 'Deploy once first (repo is stored in omnideploy.json).' };
    const b = await this.latestBuild(ctx.token, owner, repo);
    if (!b) return { id: '-', state: 'unknown', message: 'No Pages builds yet.' };
    return {
      id: b.commit ?? 'latest',
      state: b.status === 'built' ? 'ready' : b.status === 'errored' ? 'error' : 'building',
      createdAt: b.created_at,
      message: b.error?.message ?? undefined,
    };
  }

  private async repo(rootDir: string, options: ProviderOptions): Promise<{ owner: string; repo: string }> {
    if (typeof options.repo === 'string' && options.repo.includes('/')) {
      const [owner, repo] = options.repo.split('/') as [string, string];
      return { owner, repo };
    }
    const remote = await this.git.remote(rootDir);
    if (!remote?.github) {
      throw new DomainError(
        'GitHub Pages needs a GitHub repository.',
        'Add a GitHub remote (git remote add origin https://github.com/<you>/<repo>.git) or set providers["github-pages"].repo = "owner/repo".',
        'NO_GITHUB_REMOTE',
      );
    }
    return remote.github;
  }

  private async ensurePages(token: string, owner: string, repo: string, branch: string): Promise<PagesInfo> {
    const headers = this.headers(token);
    const url = `${API}/repos/${owner}/${repo}/pages`;
    const existing = await this.http.request<PagesInfo>({ url, headers }, { provider: 'GitHub', allowStatus: [404] });
    const source = { branch, path: '/' };
    if (existing.status === 404) {
      return (await this.http.request<PagesInfo>({ method: 'POST', url, headers, json: { source } }, { provider: 'GitHub', allowStatus: [409] })).data;
    }
    if (existing.data.source?.branch !== branch) {
      await this.http.request({ method: 'PUT', url, headers, json: { source } }, { provider: 'GitHub' });
    }
    return existing.data;
  }

  private async latestBuild(token: string, owner: string, repo: string): Promise<PagesBuild | null> {
    const r = await this.http.request<PagesBuild>(
      { url: `${API}/repos/${owner}/${repo}/pages/builds/latest`, headers: this.headers(token) },
      { provider: 'GitHub', allowStatus: [404] },
    );
    return r.status === 404 ? null : r.data;
  }

  private headers(token: string) {
    return { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  }
}
