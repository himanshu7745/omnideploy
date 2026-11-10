import { constants } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import type { FileSystemPort } from '../../domain/index.js';

const ALWAYS_IGNORED = ['**/node_modules/**', '**/.git/**', '**/.DS_Store'];

export class NodeFileSystem implements FileSystemPort {
  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  readText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async readTextIfExists(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw e;
    }
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  }

  async writeText(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }

  async list(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }

  async collectFiles(dir: string, opts: { ignore?: string[]; respectGitignore?: boolean } = {}): Promise<string[]> {
    const files = await fg('**/*', {
      cwd: dir,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: [...ALWAYS_IGNORED, ...(opts.ignore ?? [])],
    });
    if (!opts.respectGitignore) return files.sort();
    const gitignore = await this.readTextIfExists(join(dir, '.gitignore'));
    if (!gitignore) return files.sort();
    const ig = ignore().add(gitignore);
    return files.filter((f) => !ig.ignores(f)).sort();
  }

  async copyDir(from: string, to: string): Promise<void> {
    await cp(from, to, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(from.length)),
    });
  }

  makeTempDir(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `${prefix}-`));
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  join(...parts: string[]): string {
    return join(...parts);
  }

  resolve(...parts: string[]): string {
    return resolve(...parts);
  }
}
