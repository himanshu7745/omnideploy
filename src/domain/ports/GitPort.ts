export interface GitRemote {
  url: string;
  /** Parsed owner/repo for GitHub remotes. */
  github?: { owner: string; repo: string };
}

export interface GitPort {
  isRepo(dir: string): Promise<boolean>;
  remote(dir: string, name?: string): Promise<GitRemote | null>;
  currentBranch(dir: string): Promise<string | null>;
  /** Paths (relative) with uncommitted or untracked changes, optionally limited to `paths`. */
  dirtyPaths(dir: string, paths?: string[]): Promise<string[]>;
  commit(dir: string, paths: string[], message: string): Promise<void>;
  push(dir: string, remote?: string, branch?: string): Promise<void>;
  /** Publishes the contents of `sourceDir` as a single commit on `branch` of `remoteUrl` (force push). */
  publishDirectory(sourceDir: string, remoteUrl: string, branch: string, message: string): Promise<void>;
}
