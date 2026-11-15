import {
  checkCompatibility,
  describeProfile,
  DomainError,
  IncompatibleProviderError,
  looksLikeSecret,
  RepoAccessError,
  suggestAlternatives,
  UserCancelledError,
  type BrowserPort,
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
import type { RepositoryBootstrapper } from '../services/RepositoryBootstrapper.js';
import type { ProductionEnvironment } from '../services/ProductionEnvironment.js';
import type { SecretGuard } from '../services/SecretGuard.js';
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
    private readonly repos: RepositoryBootstrapper,
    private readonly prompt: PromptPort,
    private readonly logger: LoggerPort,
    private readonly browser: BrowserPort,
    private readonly secrets: SecretGuard,
    private readonly productionEnv: ProductionEnvironment,
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
      // Never let --preview fall through to a production deploy.
      if (!req.production && !p.capabilities.previews) {
        const withPreviews = this.providers.all().filter((x) => x.capabilities.previews && checkCompatibility(profile, x.capabilities).ok);
        throw new DomainError(
          `${p.displayName} has no preview deployments, and --preview must not deploy to production.`,
          withPreviews.length
            ? `Drop --preview to deploy to production, or preview on ${withPreviews.map((x) => x.displayName).join(' or ')}.`
            : 'Drop --preview to deploy to production.',
          'PREVIEW_UNSUPPORTED',
        );
      }
    }

    // .env.production is the single source of truth for production variables; stop now if one the app needs is missing.
    const env = await this.productionEnv.load(req.rootDir, config, {
      yes: req.yes,
      dryRun: req.dryRun,
      forWhat: targets.map((p) => p.displayName).join(', '),
    });

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
    const pushedCommit = gitTargets.length > 0 && !req.dryRun ? await this.syncGitRemote(req, gitTargets, written, resolveServiceName(profile, config)) : undefined;

    if (req.dryRun) {
      this.logger.info(`Dry run: would deploy to ${targets.map((p) => p.displayName).join(', ')}.`);
      return { profile, dryRun: true, outcomes: [] };
    }

    // 5. Build once (static sites only), then deploy to each target.
    const sourceDir = await this.build.execute(profile, { skipBuild: req.skipBuild, spinner: this.prompt.spinner(), env: env.vars });
    const serviceName = resolveServiceName(profile, config);
    const outcomes: ProviderOutcome[] = [];

    for (const p of targets) {
      const spinner = this.prompt.spinner();
      spinner.start(`Deploying to ${p.displayName}`);
      try {
        const deployment = await this.deployWithRepoAccess(p, req, spinner, () =>
          p.deploy({
            profile,
            options: config.providers[p.id] ?? {},
            token: tokens.get(p.id)!,
            sourceDir,
            production: req.production,
            serviceName,
            env: env.vars,
            pushedCommit,
            logger: this.logger,
            progress: (m) => spinner.message(`${p.displayName}: ${m}`),
          }),
        );
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

  /**
   * If the provider can't read the git repo, ask to fix it: yes opens the grant page and retries, no stops this deploy.
   * Private-repo access for third-party apps can only be granted by the account owner in the browser.
   */
  private async deployWithRepoAccess(
    p: DeploymentProvider,
    req: DeployRequest,
    spinner: ReturnType<PromptPort['spinner']>,
    run: () => Promise<Deployment>,
  ): Promise<Deployment> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (e) {
        if (!(e instanceof RepoAccessError) || !this.prompt.interactive || req.yes || attempt > 3) throw e;
        spinner.stop(`${p.displayName} cannot access ${e.repo}`, false);
        const repoPath = e.repo.replace(/^https:\/\/[^/]+\//, '');
        const go = await this.prompt.confirm(`${p.displayName} needs access to ${repoPath}. Open the page to grant it and continue deploying?`, true);
        if (!go) throw new DomainError(`Deployment to ${p.displayName} cancelled.`, e.hint, 'REPO_ACCESS');
        const opened = await this.browser.open(e.grantUrl);
        this.prompt.note(
          `${opened ? 'Opened' : 'Open'} ${e.grantUrl}\n\nSelect your account, then under Repository access add ${repoPath}\n(or choose "All repositories" so this never comes up again) and click Save.`,
          `Grant ${p.displayName} access`,
        );
        if (!(await this.prompt.confirm('Done? Continue deploying', true))) {
          throw new DomainError(`Deployment to ${p.displayName} cancelled.`, e.hint, 'REPO_ACCESS');
        }
        spinner.start(`Deploying to ${p.displayName}`);
      }
    }
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

  /** Makes sure the remote has what should be deployed. Returns the commit it pushed, if it pushed. */
  private async syncGitRemote(req: DeployRequest, targets: DeploymentProvider[], generated: string[], repoName: string): Promise<string | undefined> {
    const names = targets.map((p) => p.displayName).join(', ');
    // No remote yet: create one (with consent), then push everything below.
    const created = await this.repos.ensureRemote(req.rootDir, {
      forWhat: names,
      repoName,
      yes: req.yes,
      hostApps: targets.map((p) => p.capabilities.gitHostApps),
    });

    await this.warnAboutCommittedSecrets(req.rootDir, names);
    const dirty = await this.git.dirtyPaths(req.rootDir);
    // Secret files (.env, keys) are never offered for commit.
    const secretFiles = dirty.filter(looksLikeSecret);
    const changed = dirty.filter((d) => !secretFiles.includes(d));
    const deployFiles = changed.filter((d) => generated.includes(d) || ['Dockerfile', '.dockerignore', 'render.yaml', 'omnideploy.json'].includes(d));
    const codeFiles = changed.filter((d) => !deployFiles.includes(d));
    const unpushed = created ? 0 : await this.git.unpushedCommits(req.rootDir); // null: branch never pushed

    const needsPush = created !== null || unpushed === null || unpushed > 0;
    if (changed.length === 0 && !needsPush) return undefined; // the remote already has everything

    let toCommit = await this.chooseCommit(req, names, deployFiles, codeFiles, unpushed, created !== null);
    if (toCommit.length > 0) {
      // Last check before anything is committed: secret files → .gitignore, hard-coded secrets → user decides.
      const { exclude, ignored } = await this.secrets.review(req.rootDir, [...toCommit, ...secretFiles], { yes: req.yes });
      toCommit = toCommit.filter((f) => !exclude.includes(f));
      if (ignored.length > 0 && !toCommit.includes('.gitignore')) toCommit.push('.gitignore');
    }
    if (toCommit.length > 0) {
      const message = toCommit.some((f) => codeFiles.includes(f)) ? 'Deploy with omnideploy' : 'chore: add deployment configuration (omnideploy)';
      await this.git.commit(req.rootDir, toCommit, message);
    }
    if (toCommit.length === 0 && !needsPush) return undefined;

    try {
      if (created) await this.git.push(req.rootDir, 'origin', created.branch, { token: created.token });
      else await this.git.push(req.rootDir);
    } catch (e) {
      if (e instanceof DomainError && /rejected|non-fast-forward|fetch first/i.test(e.message)) {
        throw new DomainError(
          'The remote has commits you do not have locally, so the push was rejected.',
          'Run `git pull --rebase`, then deploy again.',
          'GIT_PUSH_REJECTED',
        );
      }
      throw e;
    }
    this.logger.success(created ? `Pushed to ${created.webUrl}` : `Pushed — ${names} will build the latest commit`);
    return (await this.git.headCommit(req.rootDir)) ?? undefined;
  }

  /** Secret files committed in the past are already on the remote — say so once per deploy, with the fix. */
  private async warnAboutCommittedSecrets(rootDir: string, names: string): Promise<void> {
    const committed = (await this.git.trackedFiles(rootDir)).filter(looksLikeSecret);
    if (committed.length === 0) return;
    const list = committed.join(', ');
    this.logger.warn(
      `${list} ${committed.length === 1 ? 'is' : 'are'} committed to git, so ${names} and anyone with access to the repository can read ${committed.length === 1 ? 'it' : 'them'}. ` +
        `To stop tracking: git rm --cached ${committed.join(' ')} — then rotate those secrets, because they stay in the git history.`,
    );
  }

  /** Which changed files to commit before pushing. [] means push existing commits only (or nothing). */
  private async chooseCommit(
    req: DeployRequest,
    names: string,
    deployFiles: string[],
    codeFiles: string[],
    unpushed: number | null,
    created: boolean,
  ): Promise<string[]> {
    const all = [...deployFiles, ...codeFiles];
    // Creating the repo already had consent; --yes means "deploy what I have".
    if (created || req.yes) return all;
    if (!this.prompt.interactive) {
      throw new DomainError(
        `${names} builds from your git remote, which does not have your local changes yet.`,
        'Commit and push them yourself, or re-run with --yes to commit and push all changes.',
        'GIT_SYNC_REQUIRED',
      );
    }
    if (all.length === 0) {
      const what = unpushed === null ? 'this branch' : `${unpushed} local commit(s)`;
      if (await this.prompt.confirm(`${names} builds from your git remote. Push ${what} so it gets deployed?`, true)) return [];
      throw new UserCancelledError();
    }

    const list = all.slice(0, 12).join('\n') + (all.length > 12 ? `\n… and ${all.length - 12} more` : '');
    this.prompt.note(list, `${all.length} uncommitted change(s)`);
    const choices: Array<{ value: string; label: string; hint?: string }> = [
      { value: 'all', label: `Commit and push all changes (${all.length} file${all.length === 1 ? '' : 's'})`, hint: 'recommended' },
    ];
    if (deployFiles.length > 0 && codeFiles.length > 0) {
      choices.push({ value: 'deploy-files', label: `Only deployment files (${deployFiles.join(', ')})`, hint: 'other changes are not deployed' });
    }
    if (deployFiles.length === 0) choices.push({ value: 'none', label: 'Deploy the last pushed commit', hint: 'local changes are left out' });
    choices.push({ value: 'cancel', label: 'Cancel' });
    const pick = await this.prompt.select(`${names} builds from your git remote. What should be deployed?`, choices);
    if (pick === 'cancel') throw new UserCancelledError();
    return pick === 'all' ? all : pick === 'deploy-files' ? deployFiles : [];
  }
}
