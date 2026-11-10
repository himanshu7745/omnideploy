export interface FileSystemPort {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readTextIfExists(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, contents: string): Promise<void>;
  /** Names of entries directly inside `dir`. */
  list(dir: string): Promise<string[]>;
  /** Files under `dir` (relative paths), honouring .gitignore and the given extra ignores. */
  collectFiles(dir: string, opts?: { ignore?: string[]; respectGitignore?: boolean }): Promise<string[]>;
  copyDir(from: string, to: string): Promise<void>;
  makeTempDir(prefix: string): Promise<string>;
  remove(path: string): Promise<void>;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}
