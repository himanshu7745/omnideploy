import {
  DeploymentFailedError,
  ProviderApiError,
  isSinglePageApp,
  type DeployContext,
  type Deployment,
  type DeploymentProvider,
  type DeploymentState,
  type DeploymentStatus,
  type FileSystemPort,
  type HttpClientPort,
  type ProjectProfile,
  type ProviderCapabilities,
  type ProviderContext,
} from '../../domain/index.js';
import { DEFAULT_POLL, filesToUpload, poll, sha1, type InMemoryFile, type PollOptions } from './support.js';

const API = 'https://api.vercel.com';

interface VercelDeployment {
  id: string;
  url: string;
  readyState?: string;
  status?: string;
  alias?: string[];
  projectId?: string;
  inspectorUrl?: string;
  errorMessage?: string;
  createdAt?: number;
}

const STATE: Record<string, DeploymentState> = {
  QUEUED: 'queued',
  INITIALIZING: 'building',
  BUILDING: 'building',
  READY: 'ready',
  ERROR: 'error',
  CANCELED: 'canceled',
};

/** Source-upload ignores for frameworks Vercel builds remotely. */
const SOURCE_IGNORES = ['.vercel/**', '.next/**', '.nuxt/**', '.output/**', '.svelte-kit/**', 'dist/**', '.env', '.env.*'];

export class VercelProvider implements DeploymentProvider {
  readonly id = 'vercel';
  readonly displayName = 'Vercel';
  readonly capabilities: ProviderCapabilities = {
    kinds: ['static', 'serverless'],
    serverLanguages: [],
    serverlessFrameworks: ['nextjs', 'nuxt', 'sveltekit', 'remix', 'astro'],
    previews: true,
    buildsFromGit: false,
    auth: { envVar: 'VERCEL_TOKEN', tokenUrl: 'https://vercel.com/account/tokens' },
  };

  constructor(
    private readonly http: HttpClientPort,
    private readonly fs: FileSystemPort,
    private readonly pollOpts: PollOptions = DEFAULT_POLL,
  ) {}

  requiredArtifacts(profile: ProjectProfile) {
    return isSinglePageApp(profile) ? ['vercel-json'] : [];
  }

  async validate(): Promise<void> {}

  async deploy(ctx: DeployContext): Promise<Deployment> {
    const isStatic = ctx.profile.kind === 'static';
    const files = await this.collect(ctx, isStatic);
    const name = (ctx.options.project as string | undefined) ?? ctx.serviceName;
    const query = { teamId: ctx.options.teamId as string | undefined, skipAutoDetectionConfirmation: 1 };
    const manifest = files.map((f) => ({ file: f.path, sha: sha1(f.data), size: f.data.byteLength }));
    let projectId = ctx.options.projectId as string | undefined;
    // Framework apps are built on Vercel, so their variables must exist on the project before the build starts.
    if (!isStatic && Object.keys(ctx.env).length > 0) {
      projectId ??= await this.ensureProject(ctx, name, query.teamId);
      await this.setEnv(ctx, projectId, query.teamId);
    }
    const body = {
      name,
      // Once known, deploy by ID so a project renamed in the dashboard keeps receiving deploys.
      ...(projectId ? { project: projectId } : {}),
      files: manifest,
      target: ctx.production ? 'production' : undefined,
      projectSettings: { framework: isStatic ? null : vercelFramework(ctx.profile.framework) },
    };

    ctx.progress(`creating deployment (${files.length} files)`);
    let created = await this.http.request<VercelDeployment & { error?: { code: string; missing?: string[] } }>(
      { method: 'POST', url: `${API}/v13/deployments`, headers: this.auth(ctx.token), query, json: body },
      { provider: 'Vercel', allowStatus: [400] },
    );
    if (created.status === 400) {
      const missing = new Set(created.data.error?.missing ?? []);
      if (created.data.error?.code !== 'missing_files' || missing.size === 0) {
        const err = created.data.error as { code?: string; message?: string } | undefined;
        throw new ProviderApiError('Vercel', err?.message ?? err?.code ?? 'bad request', 400);
      }
      await this.upload(ctx, files.filter((f) => missing.has(sha1(f.data))), query.teamId);
      ctx.progress('creating deployment');
      created = await this.http.request({ method: 'POST', url: `${API}/v13/deployments`, headers: this.auth(ctx.token), query, json: body }, { provider: 'Vercel' });
    }

    ctx.progress('building');
    const { value: d, timedOut } = await poll(
      () => this.get(ctx.token, created.data.id, query.teamId),
      (d) => ['READY', 'ERROR', 'CANCELED'].includes(d.readyState ?? d.status ?? ''),
      this.pollOpts,
    );
    const state = STATE[d.readyState ?? d.status ?? ''] ?? 'unknown';
    if (state === 'error' || state === 'canceled') {
      throw new DeploymentFailedError('Vercel', d.errorMessage ?? state, d.inspectorUrl ? `Build logs: ${d.inspectorUrl}` : undefined);
    }
    const host = ctx.production ? (d.alias?.[0] ?? d.url) : d.url;
    return {
      provider: this.id,
      id: d.id,
      url: `https://${host}`,
      state: timedOut ? 'building' : state,
      dashboardUrl: d.inspectorUrl,
      configUpdates: { project: name, projectId: d.projectId },
    };
  }

  async status(ctx: ProviderContext, deploymentId?: string): Promise<DeploymentStatus> {
    const teamId = ctx.options.teamId as string | undefined;
    let id = deploymentId;
    if (!id && !ctx.options.projectId) return { id: '-', state: 'unknown', message: 'No Vercel project yet — deploy first.' };
    if (!id) {
      const list = await this.http.request<{ deployments: Array<{ uid: string }> }>(
        { url: `${API}/v6/deployments`, headers: this.auth(ctx.token), query: { projectId: ctx.options.projectId as string, limit: 1, teamId } },
        { provider: 'Vercel' },
      );
      id = list.data.deployments[0]?.uid;
      if (!id) return { id: '-', state: 'unknown', message: 'No deployments yet.' };
    }
    const d = await this.get(ctx.token, id, teamId);
    return {
      id: d.id,
      state: STATE[d.readyState ?? d.status ?? ''] ?? 'unknown',
      url: `https://${d.url}`,
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
      message: d.errorMessage,
    };
  }

  private async collect(ctx: DeployContext, isStatic: boolean): Promise<InMemoryFile[]> {
    const root = ctx.profile.rootDir;
    const paths = isStatic
      ? await filesToUpload(this.fs, ctx.sourceDir, ctx.logger)
      : await filesToUpload(this.fs, root, ctx.logger, {
          respectGitignore: true,
          ignore: SOURCE_IGNORES,
          why: 'they look like secrets; set the values as Vercel environment variables instead',
        });
    const base = isStatic ? ctx.sourceDir : root;
    const files = await Promise.all(paths.map(async (p) => ({ path: p, data: await this.fs.readBytes(this.fs.join(base, p)) })));
    // A root vercel.json (e.g. SPA rewrites) applies to prebuilt static output too.
    if (isStatic && !paths.includes('vercel.json')) {
      const cfg = await this.fs.readTextIfExists(this.fs.join(root, 'vercel.json'));
      if (cfg) files.push({ path: 'vercel.json', data: new TextEncoder().encode(cfg) });
    }
    return files;
  }

  /** The project for `name`, created if it doesn't exist yet (normally the first deployment creates it). */
  private async ensureProject(ctx: DeployContext, name: string, teamId?: string): Promise<string> {
    const found = await this.http.request<{ id: string }>(
      { url: `${API}/v9/projects/${encodeURIComponent(name)}`, headers: this.auth(ctx.token), query: { teamId } },
      { provider: 'Vercel', allowStatus: [404] },
    );
    if (found.status !== 404) return found.data.id;
    ctx.progress('creating project');
    const created = await this.http.request<{ id: string }>(
      { method: 'POST', url: `${API}/v11/projects`, headers: this.auth(ctx.token), query: { teamId }, json: { name } },
      { provider: 'Vercel' },
    );
    return created.data.id;
  }

  /** Upserts .env.production into the project (encrypted; production and preview). */
  private async setEnv(ctx: DeployContext, projectId: string, teamId?: string): Promise<void> {
    ctx.progress('setting environment variables');
    const r = await this.http.request<{ failed?: Array<{ error: { key?: string; envVarKey?: string; message: string } }> }>(
      {
        method: 'POST',
        url: `${API}/v10/projects/${projectId}/env`,
        headers: this.auth(ctx.token),
        query: { upsert: 'true', teamId },
        json: Object.entries(ctx.env).map(([key, value]) => ({ key, value, type: 'encrypted', target: ['production', 'preview'] })),
      },
      { provider: 'Vercel' },
    );
    const failed = r.data.failed ?? [];
    if (failed.length > 0) {
      const detail = failed.map((f) => `${f.error.key ?? f.error.envVarKey ?? '?'}: ${f.error.message}`).join('; ');
      throw new ProviderApiError('Vercel', `could not set environment variables (${detail})`, undefined, 'Check the names in .env.production, or set them in the Vercel dashboard (Project → Settings → Environment Variables).');
    }
    ctx.logger.info(`Vercel: set ${Object.keys(ctx.env).length} environment variable(s) from .env.production (${Object.keys(ctx.env).join(', ')}).`);
  }

  private async upload(ctx: DeployContext, files: InMemoryFile[], teamId?: string): Promise<void> {
    let done = 0;
    const queue = [...files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        await this.http.request(
          {
            method: 'POST',
            url: `${API}/v2/files`,
            query: { teamId },
            headers: { ...this.auth(ctx.token), 'content-type': 'application/octet-stream', 'x-vercel-digest': sha1(f.data) },
            body: f.data,
          },
          { provider: 'Vercel' },
        );
        ctx.progress(`uploading files ${++done}/${files.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
  }

  private async get(token: string, id: string, teamId?: string): Promise<VercelDeployment> {
    const r = await this.http.request<VercelDeployment>({ url: `${API}/v13/deployments/${id}`, headers: this.auth(token), query: { teamId } }, { provider: 'Vercel' });
    return r.data;
  }

  private auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }
}

/** Vercel's framework identifiers differ from omnideploy's for some frameworks. */
function vercelFramework(framework?: string): string | null {
  const map: Record<string, string> = { nextjs: 'nextjs', nuxt: 'nuxtjs', sveltekit: 'sveltekit-1', remix: 'remix', astro: 'astro' };
  return framework ? (map[framework] ?? null) : null;
}
