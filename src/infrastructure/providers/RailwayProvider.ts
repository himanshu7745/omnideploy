import {
  DeploymentFailedError,
  MissingToolError,
  type DeployContext,
  type Deployment,
  type DeploymentProvider,
  type ProcessRunnerPort,
  type ProviderCapabilities,
} from '../../domain/index.js';
import { redact, redactAll } from './support.js';

const INSTALL = 'npm i -g @railway/cli   (or: brew install railway)';

/**
 * Railway's public API has no simple "upload this directory" endpoint, so this provider
 * drives the official CLI: `railway up` uploads the project (including the generated
 * Dockerfile and railway.json) and builds it on Railway.
 */
export class RailwayProvider implements DeploymentProvider {
  readonly id = 'railway';
  readonly displayName = 'Railway';
  readonly capabilities: ProviderCapabilities = {
    kinds: ['static', 'server', 'serverless'],
    serverLanguages: 'any',
    previews: false,
    buildsFromGit: false,
    requiredCli: { bin: 'railway', install: INSTALL },
    auth: { envVar: 'RAILWAY_TOKEN', tokenUrl: 'https://railway.com/account/tokens  (create a *project* token: Project → Settings → Tokens)' },
  };

  constructor(private readonly proc: ProcessRunnerPort) {}

  requiredArtifacts() {
    return ['dockerfile', 'dockerignore', 'railway-json'];
  }

  async validate(): Promise<void> {
    if (!(await this.proc.has('railway'))) throw new MissingToolError('railway', INSTALL);
  }

  async deploy(ctx: DeployContext): Promise<Deployment> {
    const env = { RAILWAY_TOKEN: ctx.token };
    const scope = [
      ...(ctx.options.service ? ['--service', String(ctx.options.service)] : []),
      ...(ctx.options.environment ? ['--environment', String(ctx.options.environment)] : []),
    ];

    if (Object.keys(ctx.env).length > 0) await this.setVariables(ctx, env, scope);

    ctx.progress('uploading and building (this can take a few minutes)');
    const up = await this.proc.run('railway', ['up', '--ci', ...scope], { cwd: ctx.profile.rootDir, env });
    const output = redact(`${up.stdout}\n${up.stderr}`, ctx.token);
    const logsUrl = output.match(/https:\/\/railway\.(?:com|app)\/project\/\S+/)?.[0];
    if (up.exitCode !== 0) {
      const tail = output.trim().split('\n').slice(-12).join('\n');
      throw new DeploymentFailedError('Railway', tail || `railway up exited with ${up.exitCode}`, railwayHint(output) ?? (logsUrl ? `Build logs: ${logsUrl}` : undefined));
    }

    ctx.progress('fetching public URL');
    const domain = await this.proc.run('railway', ['domain', ...scope], { cwd: ctx.profile.rootDir, env });
    if (domain.exitCode !== 0) ctx.logger.warn(`Railway deployed, but no public URL could be created: ${redact(domain.stderr || domain.stdout, ctx.token).trim().split('\n').pop()}`);
    const url = `${domain.stdout}\n${domain.stderr}`.match(/https:\/\/[a-z0-9.-]+\.(?:up\.railway\.app|railway\.app|[a-z]{2,})/i)?.[0];

    return {
      provider: this.id,
      id: logsUrl?.match(/[?&]id=([\w-]+)/)?.[1] ?? 'latest',
      url,
      state: 'ready',
      dashboardUrl: logsUrl,
    };
  }

  /** Sets the service's variables from .env.production before `railway up`, without triggering an extra deploy. */
  private async setVariables(ctx: DeployContext, env: Record<string, string>, scope: string[]): Promise<void> {
    ctx.progress('setting environment variables');
    const pairs = Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`);
    const run = (args: string[]) => this.proc.run('railway', args, { cwd: ctx.profile.rootDir, env });
    let r = await run(['variable', 'set', ...pairs, '--skip-deploys', ...scope]);
    let output = `${r.stdout}\n${r.stderr}`;
    // Older CLIs only know `railway variables --set KEY=VALUE`.
    if (r.exitCode !== 0 && /unrecognized|unexpected argument|invalid subcommand|unknown command|wasn't expected|found argument/i.test(output)) {
      r = await run(['variables', ...pairs.flatMap((p) => ['--set', p]), '--skip-deploys', ...scope]);
      output = `${r.stdout}\n${r.stderr}`;
    }
    if (r.exitCode !== 0) {
      const safe = redactAll(output, [ctx.token, ...Object.values(ctx.env)]).trim().split('\n').slice(-6).join('\n');
      throw new DeploymentFailedError('Railway', `could not set environment variables: ${safe}`, railwayHint(output) ?? 'Set them in the Railway dashboard (service → Variables), then deploy again.');
    }
    ctx.logger.info(`Railway: set ${pairs.length} environment variable(s) from .env.production (${Object.keys(ctx.env).join(', ')}).`);
  }
}

/** Turns the CLI's most common failures into a next step. */
export function railwayHint(output: string): string | undefined {
  if (/multiple services/i.test(output)) return 'This project has several services. Set providers.railway.service in omnideploy.json to the one to deploy.';
  if (/unauthori[sz]ed|invalid (project )?token|not authorized|project token not found/i.test(output)) {
    return 'RAILWAY_TOKEN must be a *project* token (Project → Settings → Tokens), not an account token. Run `omnideploy login railway` again.';
  }
  if (/environment .*not found/i.test(output)) return 'Check providers.railway.environment in omnideploy.json (e.g. "production").';
  return undefined;
}
