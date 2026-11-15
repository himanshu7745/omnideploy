import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/domain/index.js';
import { JsonConfigRepository } from '../../src/infrastructure/config/JsonConfigRepository.js';
import { FileCredentialStore } from '../../src/infrastructure/credentials/FileCredentialStore.js';
import { NodeFileSystem } from '../../src/infrastructure/fs/NodeFileSystem.js';
import { CliGit, parseGitHubRemote, parsePorcelainZ } from '../../src/infrastructure/git/CliGit.js';
import { ExecaProcessRunner } from '../../src/infrastructure/process/ExecaProcessRunner.js';
import { FetchHttpClient } from '../../src/infrastructure/http/FetchHttpClient.js';

const tmp = () => mkdtemp(join(tmpdir(), 'omnideploy-test-'));

describe('FetchHttpClient', () => {
  it('retries retryable statuses with backoff, then succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => (++calls < 3 ? new Response('busy', { status: 503 }) : Response.json({ ok: true }))) as typeof fetch;
    const r = await new FetchHttpClient({ fetchImpl, backoffMs: 1 }).request({ url: 'https://api.test/x' });
    expect(calls).toBe(3);
    expect(r.data).toEqual({ ok: true });
  });

  it('does not retry client errors and extracts the API message', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return Response.json({ error: { message: 'name taken' } }, { status: 422 });
    }) as typeof fetch;
    await expect(new FetchHttpClient({ fetchImpl, backoffMs: 1 }).request({ url: 'https://api.test/x' }, { provider: 'Test' })).rejects.toThrow(
      'Test API error (422): name taken',
    );
    expect(calls).toBe(1);
  });

  it('serialises query params and JSON bodies', async () => {
    let seen: Request | undefined;
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen = new Request(url, init);
      return Response.json({});
    }) as unknown as typeof fetch;
    await new FetchHttpClient({ fetchImpl }).request({ method: 'POST', url: 'https://api.test/x', query: { a: 1, b: undefined }, json: { k: 'v' } });
    expect(seen!.url).toBe('https://api.test/x?a=1');
    expect(seen!.headers.get('content-type')).toBe('application/json');
    expect(await seen!.json()).toEqual({ k: 'v' });
  });
});

describe('JsonConfigRepository', () => {
  it('round-trips config without undefined fields', async () => {
    const dir = await tmp();
    const repo = new JsonConfigRepository(new NodeFileSystem());
    await repo.save(dir, { name: 'demo', build: { command: undefined, output: 'dist' }, providers: { netlify: { siteId: 's' } } });
    expect(JSON.parse(await readFile(join(dir, 'omnideploy.json'), 'utf8'))).toEqual({
      $schema: 'https://unpkg.com/omnideploy-cli/schema.json',
      name: 'demo',
      build: { output: 'dist' },
      providers: { netlify: { siteId: 's' } },
    });
    expect(await repo.load(dir)).toEqual({ name: 'demo', build: { output: 'dist' }, providers: { netlify: { siteId: 's' } } });
  });

  it('returns null when there is no config', async () => {
    expect(await new JsonConfigRepository(new NodeFileSystem()).load(await tmp())).toBeNull();
  });

  it('reports invalid fields precisely', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'omnideploy.json'), JSON.stringify({ app: { port: 'eighty' } }));
    const err = await new JsonConfigRepository(new NodeFileSystem()).load(dir).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain('app.port');
  });
});

describe('FileCredentialStore', () => {
  it('prefers the env var, persists tokens with 0600 permissions, and deletes them', async () => {
    const file = join(await tmp(), 'nested', 'credentials.json');
    const store = new FileCredentialStore(file, { NETLIFY_AUTH_TOKEN: 'from-env' });
    await store.set('netlify', 'saved');
    await store.set('vercel', 'v-saved');

    expect(await store.get('netlify', 'NETLIFY_AUTH_TOKEN')).toEqual({ token: 'from-env', source: 'env' });
    expect(await store.get('vercel', 'VERCEL_TOKEN')).toEqual({ token: 'v-saved', source: 'store' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.delete('vercel')).toBe(true);
    expect(await store.get('vercel', 'VERCEL_TOKEN')).toBeNull();
  });
});

describe('NodeFileSystem.collectFiles', () => {
  it('skips node_modules/.git and honours .gitignore when asked', async () => {
    const dir = await tmp();
    const fs = new NodeFileSystem();
    for (const f of ['a.txt', 'secret.env', 'node_modules/x/index.js', '.git/HEAD', 'src/b.ts']) await fs.writeText(join(dir, f), 'x');
    await fs.writeText(join(dir, '.gitignore'), '*.env\n');
    expect(await fs.collectFiles(dir)).toEqual(['.gitignore', 'a.txt', 'secret.env', 'src/b.ts']);
    expect(await fs.collectFiles(dir, { respectGitignore: true })).toEqual(['.gitignore', 'a.txt', 'src/b.ts']);
  });
});

describe('parseGitHubRemote', () => {
  it.each([
    ['git@github.com:acme/app.git', { owner: 'acme', repo: 'app' }],
    ['https://github.com/acme/app', { owner: 'acme', repo: 'app' }],
    ['https://github.com/acme/acme.github.io.git', { owner: 'acme', repo: 'acme.github.io' }],
    ['https://gitlab.com/acme/app', undefined],
  ])('%s', (url, expected) => expect(parseGitHubRemote(url)).toEqual(expected));
});

describe('CliGit.dirtyPaths', () => {
  it('parses porcelain -z, including renames', () => {
    expect(parsePorcelainZ(' M pom.xml\0?? new file.txt\0R  b.txt\0a.txt\0 D gone.txt\0')).toEqual(['pom.xml', 'new file.txt', 'b.txt', 'gone.txt']);
  });

  it('keeps the first character of the first path (real git)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-git-'));
    const proc = new ExecaProcessRunner();
    const git = new CliGit(proc);
    const sh = (...args: string[]) => proc.run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
    try {
      await git.init(dir, 'main');
      await writeFile(join(dir, 'pom.xml'), '<project/>');
      await writeFile(join(dir, 'old.txt'), 'x');
      await sh('add', '-A');
      await sh('commit', '-qm', 'init');
      await writeFile(join(dir, 'pom.xml'), '<project>changed</project>');
      await mkdir(join(dir, 'src'));
      await writeFile(join(dir, 'src', 'My File.java'), 'class A {}');
      await rm(join(dir, 'old.txt'));

      const dirty = await git.dirtyPaths(dir);
      expect(dirty.sort()).toEqual(['old.txt', 'pom.xml', 'src/My File.java']);
      await git.commit(dir, dirty, 'deploy');
      expect(await git.dirtyPaths(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
