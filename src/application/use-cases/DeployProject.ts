import {
  checkCompatibility,
  describeProfile,
  DomainError,
  IncompatibleProviderError,
  suggestAlternatives,
  UserCancelledError,
  type ConfigRepositoryPort,
  type Deployment,
  type DeploymentProvider,
  type GitPort,
  type LoggerPort,
  type ProjectConfig,
  type ProjectProfile,
  type PromptPort,
} from '../../domain/index.js';
import type { CredentialResolver } from '../services/CredentialResolver.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import { resolveServiceName } from '../services/serviceName.js';
import type { BuildProject } from './BuildProject.js';
import type { DetectProject } from './DetectProject.js';
import type { GenerateArtifacts } from './GenerateArtifacts.js';

export interface DeployRequest {
  rootDir: string;
  /** Providers to deploy to; defaults to those in omnideploy.json, or asks. */
  providerIds?: string[];
  production: boolean;
  skipBuild?: boolean;
  /** Override the static output directory. */
  dir?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export interface ProviderOutcome {
  provider: string;
  displayName: string;
  ok: boolean;
  deployment?: Deployment;
  error?: unknown;
}

export interface DeployReport {
  profile: ProjectProfile;
  dryRun: boolean;
  outcomes: ProviderOutcome[];
}

/**
 * The main flow: detect → check compatibility → generate missing files → credentials →
 * preflight → sync git (for git-based providers) → build → deploy each provider → persist state.
 */
export class DeployProject {
  constructor(
    private readonly detect: DetectProject,
    private readonly providers: ProviderRegistry,
    private readonly generate: GenerateArtifacts,
    private readonly build: BuildProject,
    private readonly credentials: CredentialResolver,
    private readonly configRepo: ConfigRepositoryPort,
    private readonly git: GitPort,
    private readonly prompt: PromptPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(req: DeployRequest): Promise<DeployReport> {
    const detected = await this.detect.execute(req.rootDir);
    let profile = detected.profile;
    if (req.dir) profile = { ...profile, kind: 'static', outputDir: req.dir, buildCommand: req.skipBuild ? undefined : profile.buildCommand };
    const config: ProjectConfig = detected.config ?? { providers: {} };
    this.logger.success(`Detected ${describeProfile(profile)}`);

    const targets = await this.chooseProviders(req, profile, config);

    // 1. Compatibility — fail before touching anything.
    for (const p of targets) {
      const c = checkCompatibility(profile, p.capabilities);
      if (!c.ok) throw new IncompatibleProviderError(p.displayName, c.reason, suggestAlternatives(profile, this.providers.all(), p.id));
    }

    // 2. Deployment files (Dockerfile, render.yaml, ...).
    const { planned, written } = await this.generate.execute({
      profile,
      config,
      providerIds: targets.map((p) => p.id),
      yes: req.yes,
      force: req.force,
      dryRun: req.dryRun,
    });
    if (planned.some((a) => a.id === 'dockerfile')) profile = { ...profile, hasDockerfile: true };

    // 3. Credentials + provider preflight.
    const tokens = new Map<string, string>();
    for (const p of targets) {
      if (req.dryRun) {
        await this.credentials.resolve(p, { allowPrompt: false }).then(
          (t) => tokens.set(p.id, t),
          () => this.logger.warn(`${p.displayName}: no credentials (run \`omnideploy login ${p.id}\`)`),
        );
        continue;
      }
      tokens.set(p.id, await this.credentials.resolve(p, { allowPrompt: !req.yes }));
      await p.validate({ profile, rootDir: req.rootDir, options: config.providers[p.id] ?? {}, token: tokens.get(p.id)! });
    }

    // 4. Git-based providers build from the remote — make sure generated files are pushed.
    const gitTargets = targets.filter((p) => p.capabilities.buildsFromGit);
    if (gitTargets.length > 0 && !req.dryRun) await this.syncGitRemote(req, gitTargets, written);

    if (req.dryRun) {
      this.logger.info(`Dry run: would deploy to ${targets.map((p) => p.displayName).join(', ')}.`);
      return { profile, dryRun: true, outcomes: [] };
    }

    // 5. Build once (static sites only), then deploy to each target.
    const sourceDir = await this.build.execute(profile, { skipBuild: req.skipBuild, spinner: this.prompt.spinner() });
    const serviceName = resolveServiceName(profile, config);
    const outcomes: ProviderOutcome[] = [];

    for (const p of targets) {
      const spinner = this.prompt.spinner();
      spinner.start(`Deploying to ${p.displayName}`);
      try {
        const deployment = await p.deploy({
          profile,
          options: config.providers[p.id] ?? {},
          token: tokens.get(p.id)!,
          sourceDir,
          production: req.production,
          serviceName,
          logger: this.logger,
          progress: (m) => spinner.message(`${p.displayName}: ${m}`),
        });
        spinner.stop(`${p.displayName}: ${deployment.url ?? 'deployed'}`, true);
        outcomes.push({ provider: p.id, displayName: p.displayName, ok: true, deployment });
        config.providers[p.id] = { ...config.providers[p.id], ...deployment.configUpdates };
        await this.configRepo.save(req.rootDir, config);
      } catch (error) {
        spinner.stop(`${p.displayName}: failed`, false);
        outcomes.push({ provider: p.id, displayName: p.displayName, ok: false, error });
      }
    }
    return { profile, dryRun: false, outcomes };
  }

  private async chooseProviders(req: DeployRequest, profile: ProjectProfile, config: ProjectConfig): Promise<DeploymentProvider[]> {
    let ids = req.providerIds?.length ? req.providerIds : Object.keys(config.providers);
    if (ids.length === 0) {
      const compatible = this.providers.all().filter((p) => checkCompatibility(profile, p.capabilities).ok);
      if (!this.prompt.interactive || req.yes) {
        throw new DomainError(
          'No provider given.',
          `Run \`omnideploy deploy <provider>\` (compatible: ${compatible.map((p) => p.id).join(', ')}) or \`omnideploy init\`.`,
          'NO_PROVIDER',
        );
      }
      ids = [
        await this.prompt.select(
          'Deploy to which provider?',
          compatible.map((p) => ({ value: p.id, label: p.displayName })),
        ),
      ];
    }
    return ids.map((id) => this.providers.get(id));
  }

  private async syncGitRemote(req: DeployRequest, targets: DeploymentProvider[], generated: string[]): Promise<void> {
    const names = targets.map((p) => p.displayName).join(', ');
    if (!(await this.git.isRepo(req.rootDir)) || !(await this.git.remote(req.rootDir))) {
      throw new DomainError(
        `${names} builds from a git repository, but this project has no git remote.`,
        'Push the project to GitHub/GitLab (git init && git remote add origin <url> && git push -u origin HEAD).',
        'NO_GIT_REMOTE',
      );
    }
    const dirty = await this.git.dirtyPaths(req.rootDir);
    if (dirty.length === 0) return;

    const generatedDirty = dirty.filter((d) => generated.includes(d) || ['Dockerfile', '.dockerignore', 'render.yaml', 'omnideploy.json'].includes(d));
    const otherDirty = dirty.filter((d) => !generatedDirty.includes(d));
    if (otherDirty.length > 0) {
      this.logger.warn(`${otherDirty.length} other uncommitted change(s) will NOT be deployed by ${names} (it builds from the remote).`);
    }
    if (generatedDirty.length === 0) return;

    const ok =
      req.yes ||
      (this.prompt.interactive &&
        (await this.prompt.confirm(`${names} builds from your git remote. Commit and push ${generatedDirty.join(', ')}?`, true)));
    if (!ok) {
      if (!this.prompt.interactive && !req.yes) {
        throw new DomainError('Deployment files must be committed and pushed first.', 'Commit them yourself, or re-run with --yes.', 'GIT_SYNC_REQUIRED');
      }
      throw new UserCancelledError();
    }
    await this.git.commit(req.rootDir, generatedDirty, 'chore: add deployment configuration (omnideploy)');
    await this.git.push(req.rootDir);
    this.logger.success('Pushed deployment files');
  }
}
