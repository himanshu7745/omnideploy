import {
  DomainError,
  type AppAccessResult,
  type CreatedRepository,
  type HttpClientPort,
  type ProcessRunnerPort,
  type RepositoryHostPort,
} from '../../domain/index.js';

const API = 'https://api.github.com';

interface GitHubRepo {
  id: number;
  name: string;
  owner: { login: string };
  clone_url: string;
  html_url: string;
}

interface Installation {
  id: number;
  app_slug: string;
  repository_selection: 'all' | 'selected';
  account?: { login: string };
}

/** Creates repositories on the authenticated user's GitHub account. */
export class GitHubRepositoryHost implements RepositoryHostPort {
  readonly id = 'github';
  readonly displayName = 'GitHub';
  readonly auth = { envVar: 'GITHUB_TOKEN', tokenUrl: 'https://github.com/settings/tokens/new?scopes=repo&description=omnideploy' };

  constructor(
    private readonly http: HttpClientPort,
    private readonly proc: ProcessRunnerPort,
  ) {}

  async detectToken(): Promise<string | null> {
    if (!(await this.proc.has('gh'))) return null;
    const r = await this.proc.run('gh', ['auth', 'token']);
    const token = r.stdout.trim();
    return r.exitCode === 0 && token ? token : null;
  }

  async createRepository(token: string, opts: { name: string; private: boolean }): Promise<CreatedRepository> {
    const r = await this.http.request<GitHubRepo & { message?: string; errors?: Array<{ message?: string }> }>(
      {
        method: 'POST',
        url: `${API}/user/repos`,
        headers: this.headers(token),
        json: { name: opts.name, private: opts.private, auto_init: false },
      },
      { provider: 'GitHub', allowStatus: [422] },
    );
    if (r.status === 422) {
      const detail = r.data.errors?.map((e) => e.message).filter(Boolean).join('; ') || r.data.message || 'invalid repository';
      throw new DomainError(
        `Could not create GitHub repository "${opts.name}": ${detail}.`,
        /exists/i.test(detail)
          ? 'Pick a different name, or add the existing repository as the remote: git remote add origin https://github.com/<you>/' + opts.name + '.git'
          : 'Use a name with only letters, digits, "-", "_" and ".".',
        'REPO_CREATE_FAILED',
      );
    }
    return { id: r.data.id, owner: r.data.owner.login, name: r.data.name, cloneUrl: r.data.clone_url, webUrl: r.data.html_url };
  }

  async grantAppAccess(token: string, repo: CreatedRepository, appSlug: string): Promise<AppAccessResult> {
    const found = await this.findInstallation(token, repo.owner, appSlug);
    if (found === 'forbidden') return 'unknown-installation';
    if (!found) return 'unavailable';
    if (found.all) return 'already';
    const put = await this.http.request(
      { method: 'PUT', url: `${API}/user/installations/${found.id}/repositories/${repo.id}`, headers: this.headers(token) },
      { provider: 'GitHub', allowStatus: [401, 403, 404, 422] },
    );
    return put.status < 300 ? 'granted' : 'unavailable';
  }

  /** Personal access tokens can't list installations (403); only GitHub App user tokens can. */
  private async findInstallation(token: string, owner: string, appSlug: string): Promise<{ id: number; all: boolean } | null | 'forbidden'> {
    const r = await this.http.request<{ installations?: Installation[] }>(
      { url: `${API}/user/installations`, headers: this.headers(token), query: { per_page: 100 } },
      { provider: 'GitHub', allowStatus: [401, 403, 404] },
    );
    if (r.status !== 200) return 'forbidden';
    const i = r.data.installations?.find((x) => x.app_slug === appSlug && x.account?.login.toLowerCase() === owner.toLowerCase());
    return i ? { id: i.id, all: i.repository_selection === 'all' } : null;
  }

  private headers(token: string) {
    return { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  }
}
