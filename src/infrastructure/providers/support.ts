import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { ZipArchive } from 'archiver';
import { looksLikeSecret, type FileSystemPort, type LoggerPort } from '../../domain/index.js';

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

export const DEFAULT_POLL: PollOptions = { intervalMs: 3000, timeoutMs: 20 * 60_000 };

/** Calls `fn` until `done` is true or the timeout elapses. */
export async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, opts: PollOptions): Promise<{ value: T; timedOut: boolean }> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const value = await fn();
    if (done(value)) return { value, timedOut: false };
    if (Date.now() >= deadline) return { value, timedOut: true };
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

export const sha1 = (data: Uint8Array): string => createHash('sha1').update(data).digest('hex');

export interface InMemoryFile {
  path: string;
  data: Uint8Array;
}

export async function zip(files: InMemoryFile[]): Promise<Uint8Array> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve);
    archive.on('error', reject);
  });
  archive.pipe(sink);
  for (const f of files) archive.append(Buffer.from(f.data), { name: f.path });
  await archive.finalize();
  await finished;
  return new Uint8Array(Buffer.concat(chunks));
}

export const textFile = (path: string, text: string): InMemoryFile => ({ path, data: new TextEncoder().encode(text) });

/** Removes a secret from any string before it can reach logs or error messages. */
export const redact = (text: string, secret: string) => (secret ? text.split(secret).join('***') : text);

/** Redacts several secrets (e.g. a token plus every environment variable value). Very short values are skipped. */
export const redactAll = (text: string, secrets: readonly string[]) =>
  [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length).reduce(redact, text);

/**
 * Files under `dir` to upload, without secret files (.env, keys, ...). On static hosts every uploaded file
 * can be downloaded by anyone, so a stray .env in the output folder would be published.
 */
export async function filesToUpload(
  fs: FileSystemPort,
  dir: string,
  logger: LoggerPort,
  opts: { ignore?: string[]; respectGitignore?: boolean; why?: string } = {},
): Promise<string[]> {
  const all = await fs.collectFiles(dir, opts);
  const secrets = all.filter(looksLikeSecret);
  if (secrets.length > 0) {
    logger.warn(`Not uploading ${secrets.join(', ')}: ${opts.why ?? 'they look like secrets, and anything on a static host can be downloaded by anyone'}.`);
  }
  return all.filter((p) => !looksLikeSecret(p));
}
