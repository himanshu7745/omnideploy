import {
  DeploymentFailedError,
  MissingToolError,
  type DeployContext,
  type Deployment,
  type DeploymentProvider,
  type ProcessRunnerPort,
  type ProviderCapabilities,
} from '../../domain/index.js';
import { redact } from './support.js';

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

    ctx.progress('uploading and building (this can take a few minutes)');
    const up = await this.proc.run('railway', ['up', '--ci', ...scope], { cwd: ctx.profile.rootDir, env });
    const output = redact(`${up.stdout}\n${up.stderr}`, ctx.token);
    const logsUrl = output.match(/https:\/\/railway\.(?:com|app)\/project\/\S+/)?.[0];
    if (up.exitCode !== 0) {
      const tail = output.trim().split('\n').slice(-12).join('\n');
      throw new DeploymentFailedError('Railway', tail || `railway up exited with ${up.exitCode}`, logsUrl ? `Build logs: ${logsUrl}` : undefined);
    }

    ctx.progress('fetching public URL');
    const domain = await this.proc.run('railway', ['domain', ...scope], { cwd: ctx.profile.rootDir, env });
    const url = `${domain.stdout}\n${domain.stderr}`.match(/https:\/\/[a-z0-9.-]+\.(?:up\.railway\.app|railway\.app|[a-z]{2,})/i)?.[0];

    return {
      provider: this.id,
      id: logsUrl?.match(/[?&]id=([\w-]+)/)?.[1] ?? 'latest',
      url,
      state: 'ready',
      dashboardUrl: logsUrl,
    };
  }
}
