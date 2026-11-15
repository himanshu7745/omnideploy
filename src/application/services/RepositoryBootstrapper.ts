import {
  DomainError,
  looksLikeSecret,
  type FileSystemPort,
  type GitPort,
  type LoggerPort,
  type PromptPort,
  type RepositoryHostPort,
} from '../../domain/index.js';
import type { CredentialResolver } from './CredentialResolver.js';

export interface BootstrappedRemote {
  webUrl: string;
  branch: string;
  /** Authenticates the first push, in case the user has no git credentials for the host yet. */
  token: string;
}

const DEFAULT_GITIGNORE = `node_modules/
.env
.env.*
!.env.example
.venv/
venv/
__pycache__/
*.pyc
target/
obj/
vendor/
.DS_Store
*.log
`;

/**
 * Gives a project without a git remote one: git init (if needed), an initial commit,
 * a new private repository on the host, and `origin` pointing at it. Pushing is left to the caller.
 */
export class RepositoryBootstrapper {
  constructor(
    private readonly git: GitPort,
    private readonly host: RepositoryHostPort,
    private readonly fs: FileSystemPort,
    private readonly credentials: CredentialResolver,
    private readonly prompt: PromptPort,
    private readonly logger: LoggerPort,
  ) {}

  /** Returns null if the project already has a remote. */
  async ensureRemote(
    rootDir: string,
    opts: { forWhat: string; repoName: string; yes?: boolean; /** Apps (by host id) that must be able to read the repo. */ hostApps?: Array<Readonly<Record<string, string>> | undefined> },
  ): Promise<BootstrappedRemote | null> {
    const isRepo = await this.git.isRepo(rootDir);
    if (isRepo && (await this.git.remote(rootDir))) return null;

    const noRemote = (hint: string) =>
      new DomainError(`${opts.forWhat} builds from a git repository, but this project has no git remote.`, hint, 'NO_GIT_REMOTE');
    let name = opts.repoName;
    if (!opts.yes) {
      if (!this.prompt.interactive) {
        throw noRemote(`Re-run with --yes to create a private ${this.host.displayName} repository automatically, or add a remote yourself (git remote add origin <url>).`);
      }
      const ok = await this.prompt.confirm(
        `${opts.forWhat} builds from a git repository and this project has no remote. Create a private ${this.host.displayName} repository and push it?`,
        true,
      );
      if (!ok) throw noRemote('Add a remote yourself (git remote add origin <url> && git push -u origin HEAD), then deploy again.');
      name = (await this.prompt.text('Repository name', { initial: name, placeholder: name })).trim() || name;
    }

    const token = await this.credentials.resolveFor(this.host, {
      allowPrompt: !opts.yes,
      fallback: () => this.host.detectToken(),
    });

    // Prepare the local repository before creating anything remotely, so a refusal leaves no trace.
    if (!isRepo) {
      const ignore = this.fs.join(rootDir, '.gitignore');
      if (!(await this.fs.exists(ignore))) {
        await this.fs.writeText(ignore, DEFAULT_GITIGNORE);
        this.logger.info('Created .gitignore');
      }
      await this.git.init(rootDir, 'main');
    }
    if (!(await this.git.hasCommits(rootDir))) {
      const secrets = (await this.git.dirtyPaths(rootDir)).filter(looksLikeSecret);
      if (secrets.length > 0) {
        throw new DomainError(
          `Refusing to commit files that look like secrets: ${secrets.join(', ')}.`,
          'Add them to .gitignore, then deploy again.',
          'SECRETS_IN_COMMIT',
        );
      }
      await this.git.commitAll(rootDir, 'Initial commit (omnideploy)');
    }
    const branch = (await this.git.currentBranch(rootDir)) ?? 'main';

    const spinner = this.prompt.spinner();
    spinner.start(`Creating ${this.host.displayName} repository ${name}`);
    let repo;
    try {
      repo = await this.host.createRepository(token, { name, private: true });
    } catch (e) {
      spinner.stop(`Could not create ${this.host.displayName} repository`, false);
      throw e;
    }
    await this.git.addRemote(rootDir, 'origin', repo.cloneUrl);
    spinner.stop(`Created ${repo.webUrl} (private)`, true);

    const apps = [...new Set((opts.hostApps ?? []).map((a) => a?.[this.host.id]).filter((a): a is string => !!a))];
    for (const app of apps) {
      // Best effort: personal tokens usually can't do this, and the deploy step then asks the user to grant it.
      const result = await this.host.grantAppAccess(token, repo, app).catch(() => 'unavailable' as const);
      if (result === 'granted') this.logger.success(`Gave the ${app} ${this.host.displayName} app access to ${repo.owner}/${repo.name}`);
      else if (result !== 'already') this.logger.debug(`Could not grant ${app} access to ${repo.owner}/${repo.name} automatically (${result}).`);
    }
    return { webUrl: repo.webUrl, branch, token };
  }
}
