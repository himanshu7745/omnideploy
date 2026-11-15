export interface GitRemote {
  url: string;
  /** Parsed owner/repo for GitHub remotes. */
  github?: { owner: string; repo: string };
}

export interface GitPort {
  isRepo(dir: string): Promise<boolean>;
  remote(dir: string, name?: string): Promise<GitRemote | null>;
  currentBranch(dir: string): Promise<string | null>;
  /** SHA of HEAD, or null if there are no commits. */
  headCommit(dir: string): Promise<string | null>;
  /** Paths (relative) with uncommitted or untracked changes, optionally limited to `paths`. */
  dirtyPaths(dir: string, paths?: string[]): Promise<string[]>;
  commit(dir: string, paths: string[], message: string): Promise<void>;
  /** Stages everything not ignored and commits it. */
  commitAll(dir: string, message: string): Promise<void>;
  /** `auth.token` authenticates this push over HTTPS without touching the user's git config. */
  push(dir: string, remote?: string, branch?: string, auth?: { token: string }): Promise<void>;
  init(dir: string, branch: string): Promise<void>;
  /** Commits on the current branch not yet on its upstream; null if the branch has no upstream. */
  unpushedCommits(dir: string): Promise<number | null>;
  hasCommits(dir: string): Promise<boolean>;
  addRemote(dir: string, name: string, url: string): Promise<void>;
  /** Publishes the contents of `sourceDir` as a single commit on `branch` of `remoteUrl` (force push). */
  publishDirectory(sourceDir: string, remoteUrl: string, branch: string, message: string): Promise<void>;
}
