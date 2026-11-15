import { GitError, type GitPort, type GitRemote, type ProcessRunnerPort } from '../../domain/index.js';

export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

/** Parses `git status --porcelain -z`: "XY path\0", where renames/copies are followed by "\0origPath". */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i++; // skip the original path
  }
  return paths;
}

export class CliGit implements GitPort {
  constructor(private readonly proc: ProcessRunnerPort) {}

  private async git(dir: string, args: string[], what: string, env?: Record<string, string>): Promise<string> {
    const r = await this.proc.run('git', args, { cwd: dir, env });
    if (r.exitCode !== 0) throw new GitError(`git ${what} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  }

  async isRepo(dir: string): Promise<boolean> {
    const r = await this.proc.run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  }

  async remote(dir: string, name = 'origin'): Promise<GitRemote | null> {
    const r = await this.proc.run('git', ['remote', 'get-url', name], { cwd: dir });
    if (r.exitCode !== 0) return null;
    const url = r.stdout.trim();
    return { url, github: parseGitHubRemote(url) };
  }

  async currentBranch(dir: string): Promise<string | null> {
    const r = await this.proc.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  }

  async headCommit(dir: string): Promise<string | null> {
    const r = await this.proc.run('git', ['rev-parse', 'HEAD'], { cwd: dir });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  }

  async dirtyPaths(dir: string, paths: string[] = []): Promise<string[]> {
    // -z: NUL-separated, unquoted paths. Read stdout raw — each entry starts with a 2-char status that may be
    // a space (" M pom.xml"), so trimming the output would eat the first character of the first path.
    const r = await this.proc.run('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths], { cwd: dir });
    if (r.exitCode !== 0) throw new GitError(`git status failed: ${(r.stderr || r.stdout).trim()}`);
    return parsePorcelainZ(r.stdout);
  }

  async commit(dir: string, paths: string[], message: string): Promise<void> {
    await this.git(dir, ['add', '--', ...paths], 'add');
    await this.git(dir, [...(await this.identityArgs(dir)), 'commit', '-m', message, '--', ...paths], 'commit');
  }

  async commitAll(dir: string, message: string): Promise<void> {
    await this.git(dir, ['add', '-A'], 'add');
    await this.git(dir, [...(await this.identityArgs(dir)), 'commit', '-q', '-m', message], 'commit');
  }

  async push(dir: string, remote = 'origin', branch?: string, auth?: { token: string }): Promise<void> {
    const target = branch ?? (await this.currentBranch(dir)) ?? 'HEAD';
    // Pass the token through GIT_CONFIG_* env vars (git ≥ 2.31) so it never appears in argv or .git/config.
    const env = auth
      ? {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}`,
          GIT_TERMINAL_PROMPT: '0',
        }
      : undefined;
    await this.git(dir, ['push', '-u', remote, target], 'push', env);
  }

  async init(dir: string, branch: string): Promise<void> {
    await this.git(dir, ['init', '-q'], 'init');
    await this.git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], 'symbolic-ref');
  }

  async unpushedCommits(dir: string): Promise<number | null> {
    const r = await this.proc.run('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: dir });
    return r.exitCode === 0 ? Number(r.stdout.trim()) || 0 : null;
  }

  async hasCommits(dir: string): Promise<boolean> {
    return (await this.proc.run('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: dir })).exitCode === 0;
  }

  async addRemote(dir: string, name: string, url: string): Promise<void> {
    await this.git(dir, ['remote', 'add', name, url], 'remote add');
  }

  async publishDirectory(sourceDir: string, remoteUrl: string, branch: string, message: string): Promise<void> {
    await this.git(sourceDir, ['init', '-q'], 'init');
    await this.git(sourceDir, ['checkout', '-q', '-b', branch], 'checkout');
    await this.git(sourceDir, ['add', '-A'], 'add');
    await this.git(sourceDir, [...(await this.identityArgs(sourceDir)), 'commit', '-q', '-m', message], 'commit');
    await this.git(sourceDir, ['push', '--force', remoteUrl, `HEAD:${branch}`], 'push');
  }

  /** Lets commits succeed on machines without a configured git identity. */
  private async identityArgs(dir: string): Promise<string[]> {
    const r = await this.proc.run('git', ['config', 'user.email'], { cwd: dir });
    return r.exitCode === 0 && r.stdout.trim() ? [] : ['-c', 'user.name=omnideploy', '-c', 'user.email=omnideploy@users.noreply.github.com'];
  }
}
