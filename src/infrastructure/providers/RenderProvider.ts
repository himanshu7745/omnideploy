import {
  DeploymentFailedError,
  DomainError,
  ProviderApiError,
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
import { renderNativeBuild, renderRuntime, renderUsesDocker } from '../generators/provider-config/render.js';
import { DEFAULT_POLL, poll, type PollOptions } from './support.js';

const API = 'https://api.render.com/v1';

interface RenderService {
  id: string;
  name: string;
  dashboardUrl?: string;
  serviceDetails?: { url?: string };
}
interface RenderDeploy {
  id: string;
  status: string;
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
    buildsFromGit: true,
    auth: { envVar: 'RENDER_API_KEY', tokenUrl: 'https://dashboard.render.com/u/settings#api-keys' },
  };

  constructor(
    private readonly http: HttpClientPort,
    private readonly git: GitPort,
    private readonly pollOpts: PollOptions = DEFAULT_POLL,
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
    let deployId: string;

    if (!serviceId) {
      ownerId ??= await this.ownerId(ctx);
      ctx.progress('creating service');
      const created = await this.createService(ctx, ownerId);
      serviceId = created.service.id;
      deployId = created.deployId;
    } else {
      ctx.progress('triggering deploy');
      const r = await this.http.request<RenderDeploy>(
        { method: 'POST', url: `${API}/services/${serviceId}/deploys`, headers: this.auth(ctx.token), json: { clearCache: 'do_not_clear' } },
        { provider: 'Render' },
      );
      deployId = r.data.id;
    }

    const { value: d, timedOut } = await poll(
      () => this.getDeploy(ctx.token, serviceId!, deployId),
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

  private async createService(ctx: DeployContext, ownerId: string): Promise<{ service: RenderService; deployId: string }> {
    const p = ctx.profile;
    const remote = await this.git.remote(p.rootDir);
    const repo = remote && toHttpsRepo(remote.url);
    if (!repo) throw new DomainError('Render needs a git remote to build from.', 'git remote add origin <url> && git push -u origin HEAD', 'NO_GIT_REMOTE');
    const branch = (ctx.options.branch as string | undefined) ?? (await this.git.currentBranch(p.rootDir)) ?? 'main';
    const runtime = renderRuntime(p);

    const serviceDetails =
      runtime === 'static'
        ? { buildCommand: p.buildCommand ?? '', publishPath: p.outputDir ?? '.' }
        : {
            runtime,
            plan: (ctx.options.plan as string | undefined) ?? 'free',
            region: (ctx.options.region as string | undefined) ?? 'oregon',
            healthCheckPath: (ctx.options.healthCheckPath as string | undefined) ?? '/',
            envSpecificDetails:
              runtime === 'docker'
                ? { dockerfilePath: './Dockerfile', dockerContext: '.' }
                : { buildCommand: renderNativeBuild(p), startCommand: p.startCommand ?? '' },
          };

    try {
      const r = await this.http.request<{ service: RenderService; deployId: string }>(
        {
          method: 'POST',
          url: `${API}/services`,
          headers: this.auth(ctx.token),
          json: {
            type: runtime === 'static' ? 'static_site' : 'web_service',
            name: (ctx.options.serviceName as string | undefined) ?? ctx.serviceName,
            ownerId,
            repo,
            branch,
            autoDeploy: 'yes',
            serviceDetails,
          },
        },
        { provider: 'Render' },
      );
      return r.data;
    } catch (e) {
      if (e instanceof ProviderApiError && e.status && e.status < 500 && /repo/i.test(e.message)) {
        throw new ProviderApiError('Render', e.message, e.status, 'Connect your Git provider to Render (Account settings → Git) and grant access to this repository.');
      }
      throw e;
    }
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

/** git@github.com:o/r.git → https://github.com/o/r */
export function toHttpsRepo(url: string): string | null {
  const m = url.match(/^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)(github\.com|gitlab\.com|bitbucket\.org)[:/](.+?)(?:\.git)?\/?$/);
  return m ? `https://${m[1]}/${m[2]}` : null;
}
