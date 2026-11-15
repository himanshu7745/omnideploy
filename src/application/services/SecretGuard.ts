import {
  findSecretsInText,
  looksLikeSecret,
  UserCancelledError,
  type FileSystemPort,
  type LoggerPort,
  type PromptPort,
  type SecretMatch,
} from '../../domain/index.js';

export interface SecretFinding {
  path: string;
  /** null: the file itself is a secret file (.env, *.pem, ...). Otherwise what was found inside it. */
  matches: SecretMatch[] | null;
}

export interface SecretReview {
  /** Paths that must not be committed. */
  exclude: string[];
  /** Paths that were added to .gitignore (so .gitignore itself changed). */
  ignored: string[];
}

/** Content checks skip big or binary files: secrets live in small text files. */
const MAX_SCAN_BYTES = 512 * 1024;

/**
 * Keeps secrets out of commits: secret *files* (.env, keys) are never committed and can be added to
 * .gitignore; *hard-coded values* in files that must be committed (application.yml, appsettings.json)
 * are shown masked, and the user decides. Without a TTY, it always takes the safe option.
 */
export class SecretGuard {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly prompt: PromptPort,
    private readonly logger: LoggerPort,
  ) {}

  async scan(rootDir: string, paths: readonly string[]): Promise<SecretFinding[]> {
    const findings: SecretFinding[] = [];
    for (const path of paths) {
      if (looksLikeSecret(path)) {
        findings.push({ path, matches: null });
        continue;
      }
      const text = await this.readText(this.fs.join(rootDir, path));
      const matches = text === null ? [] : findSecretsInText(path, text);
      if (matches.length > 0) findings.push({ path, matches });
    }
    return findings;
  }

  /** Decides which of `paths` may be committed. `yes` = never ask; always choose the safe option. */
  async review(rootDir: string, paths: readonly string[], opts: { yes?: boolean }): Promise<SecretReview> {
    const findings = await this.scan(rootDir, paths);
    const secretFiles = findings.filter((f) => f.matches === null).map((f) => f.path);
    const withSecrets = findings.filter((f) => f.matches !== null);
    const ask = this.prompt.interactive && !opts.yes;
    const exclude = [...secretFiles];
    let ignored: string[] = [];

    if (secretFiles.length > 0) {
      const list = secretFiles.join(', ');
      const add = !ask || (await this.prompt.confirm(`${list} look${secretFiles.length === 1 ? 's' : ''} like secrets and won't be committed. Add to .gitignore so this doesn't come up again?`, true));
      if (add) {
        ignored = await this.addToGitignore(rootDir, secretFiles);
        if (ignored.length > 0) this.logger.info(`Added ${ignored.join(', ')} to .gitignore — they stay on your machine only.`);
      } else {
        this.logger.warn(`Not committing ${list}: they look like secrets.`);
      }
    }

    if (withSecrets.length > 0) {
      const files = withSecrets.map((f) => f.path);
      this.prompt.note(
        withSecrets.map((f) => `${f.path}\n${f.matches!.map((m) => `  line ${m.line}: ${m.kind} (${m.preview})`).join('\n')}`).join('\n'),
        'Possible hard-coded secrets',
      );
      let keepOut = true;
      if (ask) {
        const pick = await this.prompt.select('These files contain what look like secrets. Pushing them puts the secrets in your git history.', [
          { value: 'exclude', label: 'Leave these files out of the commit', hint: 'recommended — move the values to environment variables' },
          { value: 'commit', label: 'Commit them anyway', hint: 'only if these are not real secrets' },
          { value: 'cancel', label: 'Cancel' },
        ]);
        if (pick === 'cancel') throw new UserCancelledError();
        keepOut = pick === 'exclude';
      }
      if (keepOut) {
        exclude.push(...files);
        this.logger.warn(
          `Left out ${files.join(', ')}, so the deployed version of ${files.length === 1 ? 'that file' : 'those files'} stays as last pushed. ` +
            'Replace the values with environment variables (e.g. password: ${DB_PASSWORD}) and set them in the provider dashboard.',
        );
      }
    }
    return { exclude, ignored };
  }

  /** Appends paths to .gitignore (skipping ones already listed). Returns what was added. */
  async addToGitignore(rootDir: string, paths: readonly string[]): Promise<string[]> {
    const file = this.fs.join(rootDir, '.gitignore');
    const current = (await this.fs.readTextIfExists(file)) ?? '';
    const existing = new Set(current.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '')));
    const toAdd = paths.filter((p) => !existing.has(p));
    if (toAdd.length === 0) return [];
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    await this.fs.writeText(file, `${current}${prefix}${current ? '\n' : ''}# Secrets (added by omnideploy)\n${toAdd.join('\n')}\n`);
    return toAdd;
  }

  private async readText(path: string): Promise<string | null> {
    try {
      const bytes = await this.fs.readBytes(path);
      if (bytes.byteLength > MAX_SCAN_BYTES || bytes.subarray(0, 8000).includes(0)) return null;
      return new TextDecoder().decode(bytes);
    } catch {
      return null; // deleted or unreadable
    }
  }
}
