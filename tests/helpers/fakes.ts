import { posix } from 'node:path';
import type {
  Choice,
  ConfigRepositoryPort,
  CredentialStorePort,
  FileSystemPort,
  GitPort,
  RepositoryHostPort,
  AppAccessResult,
  BrowserPort,
  GitRemote,
  LoggerPort,
  ProcessRunnerPort,
  ProjectConfig,
  PromptPort,
  RunResult,
  Spinner,
  StoredCredential,
} from '../../src/domain/index.js';

/** In-memory FileSystemPort using POSIX paths. */
export class MemoryFs implements FileSystemPort {
  constructor(readonly files = new Map<string, string>()) {}
  async exists(p: string) {
    return this.files.has(p) || [...this.files.keys()].some((k) => k.startsWith(p.replace(/\/$/, '') + '/'));
  }
  async readText(p: string) {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async readTextIfExists(p: string) {
    return this.files.get(p) ?? null;
  }
  async readBytes(p: string) {
    return new TextEncoder().encode(await this.readText(p));
  }
  async writeText(p: string, c: string) {
    this.files.set(p, c);
  }
  async list(dir: string) {
    const prefix = dir.replace(/\/$/, '') + '/';
    return [...new Set([...this.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0]!))];
  }
  async collectFiles(dir: string) {
    const prefix = dir.replace(/\/$/, '') + '/';
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
  }
  async copyDir(from: string, to: string) {
    for (const f of await this.collectFiles(from)) this.files.set(posix.join(to, f), this.files.get(posix.join(from, f))!);
  }
  private tmp = 0;
  async makeTempDir(prefix: string) {
    return `/tmp/${prefix}-${++this.tmp}`;
  }
  async remove(p: string) {
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k);
  }
  join(...parts: string[]) {
    return posix.join(...parts);
  }
  resolve(...parts: string[]) {
    return posix.resolve(...parts);
  }
}

export class FakePrompt implements PromptPort {
  notes: Array<{ title?: string; body: string }> = [];
  confirms: string[] = [];
  constructor(
    readonly interactive = false,
    private readonly answers: { confirm?: boolean; select?: string; multiselect?: string[]; password?: string; text?: string | string[] } = {},
  ) {}
  async confirm(message: string) {
    this.confirms.push(message);
    return this.answers.confirm ?? true;
  }
  async select<T extends string>(_m: string, choices: Choice<T>[]) {
    return (this.answers.select as T) ?? choices[0]!.value;
  }
  async multiselect<T extends string>(_m: string, choices: Choice<T>[]) {
    return (this.answers.multiselect as T[]) ?? choices.map((c) => c.value);
  }
  async text() {
    const t = this.answers.text;
    return (Array.isArray(t) ? t.shift() : t) ?? '';
  }
  async password() {
    return this.answers.password ?? '';
  }
  note(body: string, title?: string) {
    this.notes.push({ body, title });
  }
  spinner(): Spinner {
    return { start() {}, message() {}, stop() {} };
  }
}

export class MemoryLogger implements LoggerPort {
  lines: string[] = [];
  info = (m: string) => void this.lines.push(`info: ${m}`);
  step = (m: string) => void this.lines.push(`step: ${m}`);
  success = (m: string) => void this.lines.push(`success: ${m}`);
  warn = (m: string) => void this.lines.push(`warn: ${m}`);
  error = (m: string) => void this.lines.push(`error: ${m}`);
  debug = () => {};
}

export class MemoryCredentials implements CredentialStorePort {
  constructor(readonly tokens: Record<string, string> = {}) {}
  async get(id: string): Promise<StoredCredential | null> {
    return this.tokens[id] ? { token: this.tokens[id]!, source: 'store' } : null;
  }
  async set(id: string, token: string) {
    this.tokens[id] = token;
  }
  async delete(id: string) {
    const had = id in this.tokens;
    delete this.tokens[id];
    return had;
  }
}

export class MemoryConfigRepo implements ConfigRepositoryPort {
  readonly fileName = 'omnideploy.json';
  saved: ProjectConfig[] = [];
  constructor(public config: ProjectConfig | null = null) {}
  async load() {
    return this.config ? structuredClone(this.config) : null;
  }
  async save(_root: string, config: ProjectConfig) {
    this.config = structuredClone(config);
    this.saved.push(this.config);
  }
}

export class FakeGit implements GitPort {
  commits: Array<{ paths: string[]; message: string }> = [];
  pushes = 0;
  pushAuth: Array<{ token: string } | undefined> = [];
  published: Array<{ dir: string; remoteUrl: string; branch: string }> = [];
  inited: string[] = [];
  /** Local commits not on the remote; null = branch has no upstream. */
  unpushed: number | null = 0;
  pushError?: Error;
  constructor(
    public remoteInfo: GitRemote | null = { url: 'git@github.com:acme/app.git', github: { owner: 'acme', repo: 'app' } },
    public dirty: string[] = [],
    public repo = remoteInfo !== null,
    public committed = repo,
  ) {}
  async isRepo() {
    return this.repo;
  }
  async init(_d: string, branch: string) {
    this.repo = true;
    this.inited.push(branch);
  }
  head: string | null = 'abc1234';
  async headCommit() {
    return this.head;
  }
  async unpushedCommits() {
    return this.unpushed;
  }
  async hasCommits() {
    return this.committed;
  }
  async commitAll(_d: string, message: string) {
    this.commits.push({ paths: [...this.dirty], message });
    this.dirty = [];
    this.committed = true;
  }
  async addRemote(_d: string, _name: string, url: string) {
    this.remoteInfo = { url };
  }
  async remote() {
    return this.remoteInfo;
  }
  async currentBranch() {
    return 'main';
  }
  async dirtyPaths() {
    return this.dirty;
  }
  async commit(_d: string, paths: string[], message: string) {
    this.commits.push({ paths, message });
    this.dirty = this.dirty.filter((d) => !paths.includes(d));
  }
  async push(_d?: string, _r?: string, _b?: string, auth?: { token: string }) {
    if (this.pushError) throw this.pushError;
    this.pushes++;
    this.pushAuth.push(auth);
  }
  async publishDirectory(dir: string, remoteUrl: string, branch: string) {
    this.published.push({ dir, remoteUrl, branch });
  }
}

export class FakeRepoHost implements RepositoryHostPort {
  readonly id = 'github';
  readonly displayName = 'GitHub';
  readonly auth = { envVar: 'GITHUB_TOKEN', tokenUrl: 'https://github.test/tokens' };
  created: Array<{ token: string; name: string; private: boolean }> = [];
  grants: string[] = [];
  constructor(
    public cliToken: string | null = null,
    public grantResult: AppAccessResult = 'granted',
  ) {}
  async grantAppAccess(_t: string, repo: { owner: string; name: string }, app: string) {
    this.grants.push(`${app}:${repo.owner}/${repo.name}`);
    return this.grantResult;
  }
  async detectToken() {
    return this.cliToken;
  }
  async createRepository(token: string, opts: { name: string; private: boolean }) {
    this.created.push({ token, ...opts });
    return { id: 42, owner: 'me', name: opts.name, cloneUrl: `https://github.com/me/${opts.name}.git`, webUrl: `https://github.com/me/${opts.name}` };
  }
}

export class FakeBrowser implements BrowserPort {
  opened: string[] = [];
  async open(url: string) {
    this.opened.push(url);
    return true;
  }
}

export class FakeProcess implements ProcessRunnerPort {
  calls: Array<{ bin: string; args: string[]; env?: Record<string, string | undefined> }> = [];
  constructor(
    private readonly handler: (bin: string, args: string[]) => Partial<RunResult> = () => ({}),
    private readonly installed: string[] = [],
  ) {}
  async run(bin: string, args: string[], opts: { env?: Record<string, string | undefined> } = {}) {
    this.calls.push({ bin, args, env: opts.env });
    return { exitCode: 0, stdout: '', stderr: '', ...this.handler(bin, args) };
  }
  async shell(command: string) {
    return this.run('sh', ['-c', command]);
  }
  async has(bin: string) {
    return this.installed.includes(bin);
  }
}
