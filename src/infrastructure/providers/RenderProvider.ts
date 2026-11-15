import {
  DeploymentFailedError,
  DomainError,
  ProviderApiError,
  RepoAccessError,
  isSinglePageApp,
  type DeployContext,
  type Deployment,
  type DeploymentProvider,
  type DeploymentState,
  type DeploymentStatus,
  type GitPort,
  type HttpClientPort,
  type ProjectProfile,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderOptions,
} from '../../domain/index.js';
import { renderNativeBuild, renderRuntime, renderStaticBuild, renderUsesDocker } from '../generators/provider-config/render.js';
import { DEFAULT_POLL, poll, type PollOptions } from './support.js';

const API = 'https://api.render.com/v1';

interface RenderService {
  id: string;
  name: string;
  repo?: string;
  autoDeploy?: 'yes' | 'no';
  dashboardUrl?: string;
  serviceDetails?: { url?: string };
}
interface RenderDeploy {
  id: string;
  status: string;
  commit?: { id: string };
  createdAt?: string;
  finishedAt?: string;
}

const STATE: Record<string, DeploymentState> = {
  created: 'queued',
  queued: 'queued',
  build_in_progress: 'building',
  update_in_progress: 'building',
  pre_deploy_in_progress: 'building',
  live: 'ready',
  deactivated: 'ready',
  build_failed: 'error',
  update_failed: 'error',
  pre_deploy_failed: 'error',
  canceled: 'canceled',
};
const FINAL = new Set(['live', 'deactivated', 'build_failed', 'update_failed', 'pre_deploy_failed', 'canceled']);

/** Render builds from the git remote (natively or from the generated Dockerfile). */
export class RenderProvider implements DeploymentProvider {
  readonly id = 'render';
  readonly displayName = 'Render';
  readonly capabilities: ProviderCapabilities = {
    kinds: ['static', 'server', 'serverless'],
    serverLanguages: 'any',
    previews: false,
    buildsFromGit: true,
    auth: { envVar: 'RENDER_API_KEY', tokenUrl: 'https://dashboard.render.com/u/settings#api-keys' },
    gitHostApps: { github: 'render' },
  };

  constructor(
    private readonly http: HttpClientPort,
    private readonly git: GitPort,
    private readonly pollOpts: PollOptions = DEFAULT_POLL,
    /** How long to wait for Render's auto-deploy to pick up a commit omnideploy just pushed. */
    private readonly autoDeployWaitMs = 30_000,
  ) {}

  requiredArtifacts(profile: ProjectProfile) {
    return renderUsesDocker(profile) ? ['dockerfile', 'dockerignore', 'render-yaml'] : ['render-yaml'];
  }

  async validate(ctx: { rootDir: string; options: ProviderOptions }): Promise<void> {
    if (ctx.options.serviceId) return;
    const remote = await this.git.remote(ctx.rootDir);
    if (remote && !toHttpsRepo(remote.url)) {
      throw new DomainError(`Render cannot use the git remote "${remote.url}".`, 'Use a GitHub, GitLab or Bitbucket remote.', 'UNSUPPORTED_REMOTE');
    }
  }

  async deploy(ctx: DeployContext): Promise<Deployment> {
    let serviceId = ctx.options.serviceId as string | undefined;
    let ownerId = ctx.options.ownerId as string | undefined;
    let deployId: string | undefined;

    if (serviceId) {
      const existing = await this.findServiceById(ctx.token, serviceId);
      if (existing) {
        // A build that already started (auto-deploy of the push) would run with the old variables.
        const envChanged = await this.syncEnv(ctx, existing.id);
        deployId = await this.startDeploy(ctx, existing, !envChanged);
      }
      else {
        // Deleted in the dashboard: start over instead of failing on every deploy.
        ctx.logger.warn(`The saved Render service ${serviceId} no longer exists, so a new one will be created.`);
        serviceId = undefined;
      }
    }
    if (!serviceId) {
      ownerId ??= await this.ownerId(ctx);
      ctx.progress('creating service');
      const created = await this.createService(ctx, ownerId);
      serviceId = created.service.id;
      deployId = created.deployId;
      if (!created.adopted && renderRuntime(ctx.profile) === 'static' && isSinglePageApp(ctx.profile)) await this.addSpaRewrite(ctx, serviceId);
    }

    const { value: d, timedOut } = await poll(
      () => this.getDeploy(ctx.token, serviceId!, deployId!),
      (d) => {
        ctx.progress(`${d.status.replace(/_/g, ' ')} (Render builds can take several minutes)`);
        return FINAL.has(d.status);
      },
      this.pollOpts,
    );
    const service = await this.getService(ctx.token, serviceId);
    const state = STATE[d.status] ?? 'unknown';
    if (state === 'error' || state === 'canceled') {
      throw new DeploymentFailedError('Render', d.status.replace(/_/g, ' '), service.dashboardUrl ? `Logs: ${service.dashboardUrl}/deploys/${d.id}` : undefined);
    }
    return {
      provider: this.id,
      id: d.id,
      url: service.serviceDetails?.url,
      state: timedOut ? 'building' : state,
      dashboardUrl: service.dashboardUrl,
      configUpdates: { serviceId, ownerId },
    };
  }

  async status(ctx: ProviderContext, deploymentId?: string): Promise<DeploymentStatus> {
    const serviceId = ctx.options.serviceId as string | undefined;
    if (!serviceId) return { id: '-', state: 'unknown', message: 'No Render service yet — deploy first.' };
    let d: RenderDeploy | undefined;
    if (deploymentId) d = await this.getDeploy(ctx.token, serviceId, deploymentId);
    else {
      const r = await this.http.request<Array<{ deploy: RenderDeploy }>>({ url: `${API}/services/${serviceId}/deploys`, headers: this.auth(ctx.token), query: { limit: 1 } }, { provider: 'Render' });
      d = r.data[0]?.deploy;
    }
    if (!d) return { id: '-', state: 'unknown', message: 'No deploys yet.' };
    const service = await this.getService(ctx.token, serviceId);
    return { id: d.id, state: STATE[d.status] ?? 'unknown', url: service.serviceDetails?.url, createdAt: d.createdAt, message: d.status };
  }

  /** Starts a deploy of an existing service, or joins the one Render's auto-deploy started for our push. */
  private async startDeploy(ctx: DeployContext, service: RenderService, followAutoDeploy = true): Promise<string> {
    if (followAutoDeploy && ctx.pushedCommit && service.autoDeploy !== 'no') {
      ctx.progress('waiting for Render to pick up the push');
      const { value } = await poll(
        () => this.recentDeploys(ctx.token, service.id),
        (ds) => ds.some((d) => d.commit?.id === ctx.pushedCommit),
        { intervalMs: this.pollOpts.intervalMs, timeoutMs: this.autoDeployWaitMs },
      );
      const auto = value.find((d) => d.commit?.id === ctx.pushedCommit);
      if (auto) return auto.id;
    }
    ctx.progress('triggering deploy');
    const r = await this.http.request<RenderDeploy | null>(
      {
        method: 'POST',
        url: `${API}/services/${service.id}/deploys`,
        headers: this.auth(ctx.token),
        json: { clearCache: 'do_not_clear', ...(ctx.pushedCommit ? { commitId: ctx.pushedCommit } : {}) },
      },
      { provider: 'Render' },
    );
    if (r.data?.id) return r.data.id;
    // 202 Queued (another deploy is running) comes without a body: follow the newest deploy.
    const [latest] = await this.recentDeploys(ctx.token, service.id);
    if (!latest) throw new DeploymentFailedError('Render', 'the deploy was queued but could not be found', service.dashboardUrl);
    return latest.id;
  }

  /**
   * Adds/updates the service's variables from .env.production. Render's API replaces the whole list,
   * so the current variables are read first and kept. Returns true if anything changed.
   */
  private async syncEnv(ctx: DeployContext, serviceId: string): Promise<boolean> {
    const wanted = Object.entries(ctx.env);
    if (wanted.length === 0) return false;
    const current = new Map<string, string>();
    for (let cursor: string | undefined; ; ) {
      const r = await this.http.request<Array<{ envVar: { key: string; value: string }; cursor: string }>>(
        { url: `${API}/services/${serviceId}/env-vars`, headers: this.auth(ctx.token), query: { limit: 100, cursor } },
        { provider: 'Render' },
      );
      for (const { envVar } of r.data) current.set(envVar.key, envVar.value);
      if (r.data.length < 100) break;
      cursor = r.data.at(-1)!.cursor;
    }
    const added = wanted.filter(([k]) => !current.has(k)).map(([k]) => k);
    const updated = wanted.filter(([k, v]) => current.has(k) && current.get(k) !== v).map(([k]) => k);
    if (added.length === 0 && updated.length === 0) {
      ctx.logger.info('Render: environment variables already match .env.production.');
      return false;
    }
    ctx.progress('setting environment variables');
    for (const [k, v] of wanted) current.set(k, v);
    await this.http.request(
      { method: 'PUT', url: `${API}/services/${serviceId}/env-vars`, headers: this.auth(ctx.token), json: [...current].map(([key, value]) => ({ key, value })) },
      { provider: 'Render' },
    );
    ctx.logger.info(`Render: ${describeEnvChange(added, updated)} from .env.production.`);
    return true;
  }

  private async recentDeploys(token: string, serviceId: string): Promise<RenderDeploy[]> {
    const r = await this.http.request<Array<{ deploy: RenderDeploy }>>(
      { url: `${API}/services/${serviceId}/deploys`, headers: this.auth(token), query: { limit: 5 } },
      { provider: 'Render' },
    );
    return r.data.map((x) => x.deploy);
  }

  private async findServiceById(token: string, serviceId: string): Promise<RenderService | null> {
    const r = await this.http.request<RenderService>({ url: `${API}/services/${serviceId}`, headers: this.auth(token) }, { provider: 'Render', allowStatus: [404] });
    return r.status === 404 ? null : r.data;
  }

  /** Static sites created through the API get no rewrite rules from render.yaml, so add the SPA fallback. */
  private async addSpaRewrite(ctx: DeployContext, serviceId: string): Promise<void> {
    try {
      await this.http.request(
        { method: 'POST', url: `${API}/services/${serviceId}/routes`, headers: this.auth(ctx.token), json: { type: 'rewrite', source: '/*', destination: '/index.html' } },
        { provider: 'Render' },
      );
    } catch {
      ctx.logger.warn('Could not add the SPA rewrite on Render. Add "/* → /index.html (Rewrite)" under the site\'s Redirects/Rewrites so deep links work.');
    }
  }

  private async ownerId(ctx: DeployContext): Promise<string> {
    const r = await this.http.request<Array<{ owner: { id: string; name: string } }>>(
      { url: `${API}/owners`, headers: this.auth(ctx.token), query: { limit: 20 } },
      { provider: 'Render' },
    );
    const owners = r.data.map((o) => o.owner);
    if (owners.length === 0) throw new DomainError('Your Render account has no workspace.', 'Create one at https://dashboard.render.com.', 'RENDER_NO_OWNER');
    if (owners.length > 1) ctx.logger.warn(`Using Render workspace "${owners[0]!.name}". Set providers.render.ownerId to choose another.`);
    return owners[0]!.id;
  }

  private async createService(ctx: DeployContext, ownerId: string): Promise<{ service: RenderService; deployId: string; adopted?: boolean }> {
    const p = ctx.profile;
    const remote = await this.git.remote(p.rootDir);
    const repo = remote && toHttpsRepo(remote.url);
    if (!repo) throw new DomainError('Render needs a git remote to build from.', 'git remote add origin <url> && git push -u origin HEAD', 'NO_GIT_REMOTE');
    const branch = (ctx.options.branch as string | undefined) ?? (await this.git.currentBranch(p.rootDir)) ?? 'main';
    const runtime = renderRuntime(p);

    const serviceDetails =
      runtime === 'static'
        ? { buildCommand: renderStaticBuild(p), publishPath: p.outputDir ?? '.' }
        : {
            runtime,
            plan: (ctx.options.plan as string | undefined) ?? 'free',
            region: (ctx.options.region as string | undefined) ?? 'oregon',
            healthCheckPath: (ctx.options.healthCheckPath as string | undefined) ?? p.healthCheckPath ?? '/',
            envSpecificDetails:
              runtime === 'docker'
                ? { dockerfilePath: './Dockerfile', dockerContext: '.' }
                : { buildCommand: renderNativeBuild(p), startCommand: p.startCommand ?? '' },
          };

    const wanted = (ctx.options.serviceName as string | undefined) ?? ctx.serviceName;
    // A name can already be taken in the workspace (an earlier deploy, or a service made in the dashboard).
    // Same repo → reuse that service; otherwise fall back to a stable, repo-specific name.
    const candidates = ctx.options.serviceName ? [wanted] : [wanted, `${wanted}-${shortHash(repo)}`];
    for (const name of candidates) {
      try {
        const r = await this.http.request<{ service: RenderService; deployId: string }>(
          {
            method: 'POST',
            url: `${API}/services`,
            headers: this.auth(ctx.token),
            json: {
              type: runtime === 'static' ? 'static_site' : 'web_service',
              name,
              ownerId,
              repo,
              branch,
              autoDeploy: 'yes',
              serviceDetails,
              // Set before the first build, so it already has them.
              ...(Object.keys(ctx.env).length > 0 ? { envVars: Object.entries(ctx.env).map(([key, value]) => ({ key, value })) } : {}),
            },
          },
          { provider: 'Render' },
        );
        if (name !== wanted) ctx.logger.warn(`A Render service named "${wanted}" already exists for another repo, so this one is "${name}".`);
        return r.data;
      } catch (e) {
        if (e instanceof ProviderApiError && e.status && e.status < 500 && /already (in use|exists|taken)/i.test(e.message)) {
          const existing = await this.findService(ctx.token, ownerId, name);
          if (existing && sameRepo(existing.repo, repo)) {
            ctx.logger.info(`Using the existing Render service "${name}" (it builds this repo).`);
            const envChanged = await this.syncEnv(ctx, existing.id);
            return { service: existing, deployId: await this.startDeploy(ctx, existing, !envChanged), adopted: true };
          }
          continue;
        }
        if (e instanceof ProviderApiError && e.status && e.status < 500 && /repo/i.test(e.message)) {
          // e.message already carries the "Render API error (400):" prefix — don't wrap it in another ProviderApiError.
          throw new RepoAccessError('Render', repo, repoGrantUrl(repo), repoAccessHint(repo));
        }
        throw e;
      }
    }
    throw new DomainError(
      `The Render service name "${wanted}" is already used by another service in this workspace.`,
      'Set providers.render.serviceName in omnideploy.json to a free name, or providers.render.serviceId to deploy to an existing service.',
      'RENDER_NAME_TAKEN',
    );
  }

  private async findService(token: string, ownerId: string, name: string): Promise<RenderService | undefined> {
    const r = await this.http.request<Array<{ service: RenderService }>>(
      { url: `${API}/services`, headers: this.auth(token), query: { name, ownerId, limit: 20 } },
      { provider: 'Render' },
    );
    return r.data.map((x) => x.service).find((x) => x.name === name);
  }

  private async getDeploy(token: string, serviceId: string, deployId: string): Promise<RenderDeploy> {
    return (await this.http.request<RenderDeploy>({ url: `${API}/services/${serviceId}/deploys/${deployId}`, headers: this.auth(token) }, { provider: 'Render' })).data;
  }

  private async getService(token: string, serviceId: string): Promise<RenderService> {
    return (await this.http.request<RenderService>({ url: `${API}/services/${serviceId}`, headers: this.auth(token) }, { provider: 'Render' })).data;
  }

  private auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }
}

function describeEnvChange(added: string[], updated: string[]): string {
  return [added.length && `added ${added.join(', ')}`, updated.length && `updated ${updated.join(', ')}`].filter(Boolean).join('; ');
}

const normRepo = (u?: string) => (u ?? '').toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
function sameRepo(a: string | undefined, b: string): boolean {
  return normRepo(a) === normRepo(b);
}

/** Short, stable suffix derived from the repo URL, so re-runs pick the same fallback name. */
function shortHash(text: string): string {
  let h = 5381;
  for (const c of normRepo(text)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36).slice(0, 5);
}

/** GitHub's own page for choosing which repositories Render's app may read. */
function repoGrantUrl(repo: string): string {
  return repo.startsWith('https://github.com/') ? 'https://github.com/apps/render/installations/new' : 'https://dashboard.render.com/settings#git';
}

function repoAccessHint(repo: string): string {
  const path = repo.replace(/^https:\/\/[^/]+\//, '');
  if (repo.startsWith('https://github.com/')) {
    return (
      `Give Render's GitHub app access to ${path}: open https://github.com/settings/installations → Render → Configure → ` +
      `Repository access → add ${path} (or choose "All repositories"), then run the deploy again. ` +
      'If Render is not listed there, connect GitHub in the Render dashboard first (Account settings → Git).'
    );
  }
  return `Connect your Git provider in the Render dashboard (Account settings → Git), grant it access to ${path}, then run the deploy again.`;
}

/** git@github.com:o/r.git → https://github.com/o/r */
export function toHttpsRepo(url: string): string | null {
  const m = url.match(/^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)(github\.com|gitlab\.com|bitbucket\.org)[:/](.+?)(?:\.git)?\/?$/);
  return m ? `https://${m[1]}/${m[2]}` : null;
}
