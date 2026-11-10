import type { FileSystemPort } from '../../domain/index.js';

export async function readJson<T = Record<string, any>>(fs: FileSystemPort, path: string): Promise<T | null> {
  const raw = await fs.readTextIfExists(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function firstExisting(fs: FileSystemPort, root: string, candidates: string[]): Promise<string | undefined> {
  for (const c of candidates) if (await fs.exists(fs.join(root, c))) return c;
  return undefined;
}

export function hasDockerfile(fs: FileSystemPort, root: string): Promise<boolean> {
  return fs.exists(fs.join(root, 'Dockerfile'));
}

/** "^8.2", ">=3.11,<4", "v20.11.0", "21" → "8.2", "3.11", "20", "21" */
export function extractVersion(spec: string | undefined | null, parts = 2): string | undefined {
  if (!spec) return undefined;
  const m = spec.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return undefined;
  return [m[1], m[2], m[3]].slice(0, parts).filter((x) => x !== undefined).join('.');
}
