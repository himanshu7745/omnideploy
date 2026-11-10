import { GitError, type GitPort, type GitRemote, type ProcessRunnerPort } from '../../domain/index.js';

export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

export class CliGit implements GitPort {
  constructor(private readonly proc: ProcessRunnerPort) {}

  private async git(dir: string, args: string[], what: string): Promise<string> {
    const r = await this.proc.run('git', args, { cwd: dir });
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

  async dirtyPaths(dir: string, paths: string[] = []): Promise<string[]> {
    const out = await this.git(dir, ['status', '--porcelain', '--untracked-files=all', '--', ...paths], 'status');
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''));
  }

  async commit(dir: string, paths: string[], message: string): Promise<void> {
    await this.git(dir, ['add', '--', ...paths], 'add');
    await this.git(dir, [...(await this.identityArgs(dir)), 'commit', '-m', message, '--', ...paths], 'commit');
  }

  async push(dir: string, remote = 'origin', branch?: string): Promise<void> {
    const target = branch ?? (await this.currentBranch(dir)) ?? 'HEAD';
    await this.git(dir, ['push', '-u', remote, target], 'push');
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
