import {
  DeploymentFailedError,
  isSinglePageApp,
  type DeployContext,
  type Deployment,
  type DeploymentProvider,
  type DeploymentState,
  type DeploymentStatus,
  type FileSystemPort,
  type HttpClientPort,
  type ProviderCapabilities,
  type ProviderContext,
} from '../../domain/index.js';
import { DEFAULT_POLL, filesToUpload, poll, textFile, zip, type PollOptions } from './support.js';

const API = 'https://api.netlify.com/api/v1';

interface NetlifySite {
  id: string;
  name: string;
  ssl_url?: string;
  url: string;
  admin_url?: string;
}
interface NetlifyDeploy {
  id: string;
  state: string;
  ssl_url?: string;
  deploy_ssl_url?: string;
  admin_url?: string;
  error_message?: string;
  created_at?: string;
}

const STATE: Record<string, DeploymentState> = {
  new: 'queued',
  uploading: 'building',
  uploaded: 'building',
  preparing: 'building',
  prepared: 'building',
  processing: 'building',
  processed: 'building',
  ready: 'ready',
  error: 'error',
};

export class NetlifyProvider implements DeploymentProvider {
  readonly id = 'netlify';
  readonly displayName = 'Netlify';
  readonly capabilities: ProviderCapabilities = {
    kinds: ['static'],
    serverLanguages: [],
    previews: true,
    buildsFromGit: false,
    auth: { envVar: 'NETLIFY_AUTH_TOKEN', tokenUrl: 'https://app.netlify.com/user/applications#personal-access-tokens' },
  };

  constructor(
    private readonly http: HttpClientPort,
    private readonly fs: FileSystemPort,
    private readonly pollOpts: PollOptions = DEFAULT_POLL,
  ) {}

  requiredArtifacts() {
    return ['netlify-toml'];
  }

  async validate(): Promise<void> {}

  async deploy(ctx: DeployContext): Promise<Deployment> {
    const site = await this.ensureSite(ctx);

    ctx.progress('packaging files');
    const paths = await filesToUpload(this.fs, ctx.sourceDir, ctx.logger);
    const files = await Promise.all(paths.map(async (p) => ({ path: p, data: await this.fs.readBytes(this.fs.join(ctx.sourceDir, p)) })));
    // Zip deploys ignore netlify.toml, so SPA redirects must ship as _redirects.
    if (isSinglePageApp(ctx.profile) && !paths.includes('_redirects')) files.push(textFile('_redirects', '/*  /index.html  200\n'));
    const archive = await zip(files);

    ctx.progress(`uploading ${files.length} files`);
    const created = await this.http.request<NetlifyDeploy>(
      {
        method: 'POST',
        url: `${API}/sites/${site.id}/deploys`,
        headers: { ...this.auth(ctx.token), 'content-type': 'application/zip' },
        query: { draft: ctx.production ? undefined : true },
        body: archive,
      },
      { provider: 'Netlify' },
    );

    ctx.progress('processing');
    const { value: d, timedOut } = await poll(
      () => this.getDeploy(ctx.token, created.data.id),
      (d) => d.state === 'ready' || d.state === 'error',
      this.pollOpts,
    );
    if (d.state === 'error') throw new DeploymentFailedError('Netlify', d.error_message ?? 'unknown error', d.admin_url);

    return {
      provider: this.id,
      id: d.id,
      url: ctx.production ? (site.ssl_url ?? d.ssl_url ?? site.url) : (d.deploy_ssl_url ?? d.ssl_url),
      state: timedOut ? 'building' : 'ready',
      dashboardUrl: site.admin_url,
      configUpdates: { siteId: site.id, siteName: site.name },
    };
  }

  async status(ctx: ProviderContext, deploymentId?: string): Promise<DeploymentStatus> {
    let d: NetlifyDeploy | undefined;
    if (deploymentId) d = await this.getDeploy(ctx.token, deploymentId);
    else {
      const siteId = ctx.options.siteId as string | undefined;
      if (!siteId) return { id: '-', state: 'unknown', message: 'No Netlify site yet — deploy first.' };
      const r = await this.http.request<NetlifyDeploy[]>({ url: `${API}/sites/${siteId}/deploys`, headers: this.auth(ctx.token), query: { per_page: 1 } }, { provider: 'Netlify' });
      d = r.data[0];
    }
    if (!d) return { id: '-', state: 'unknown', message: 'No deployments yet.' };
    return { id: d.id, state: STATE[d.state] ?? 'unknown', url: d.deploy_ssl_url ?? d.ssl_url, createdAt: d.created_at, message: d.error_message };
  }

  private async ensureSite(ctx: DeployContext): Promise<NetlifySite> {
    const siteId = ctx.options.siteId as string | undefined;
    if (siteId) {
      const r = await this.http.request<NetlifySite>({ url: `${API}/sites/${siteId}`, headers: this.auth(ctx.token) }, { provider: 'Netlify', allowStatus: [404] });
      if (r.status !== 404) return r.data;
      // Deleted in the dashboard: start over instead of failing on every deploy.
      ctx.logger.warn(`The saved Netlify site ${siteId} no longer exists, so a new one will be created.`);
    }
    ctx.progress('creating site');
    const base = (ctx.options.siteName as string | undefined) ?? ctx.serviceName;
    // Site names are global; retry with a suffix if the name is taken.
    for (const name of [base, `${base}-${randomSuffix()}`, `${base}-${randomSuffix()}`]) {
      const r = await this.http.request<NetlifySite>(
        { method: 'POST', url: `${API}/sites`, headers: this.auth(ctx.token), json: { name } },
        { provider: 'Netlify', allowStatus: [422] },
      );
      if (r.status !== 422) return r.data;
    }
    throw new DeploymentFailedError('Netlify', `could not create a site named "${base}"`, 'Set providers.netlify.siteName in omnideploy.json.');
  }

  private async getDeploy(token: string, id: string): Promise<NetlifyDeploy> {
    return (await this.http.request<NetlifyDeploy>({ url: `${API}/deploys/${id}`, headers: this.auth(token) }, { provider: 'Netlify' })).data;
  }

  private auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }
}

const randomSuffix = () => Math.random().toString(36).slice(2, 7);
