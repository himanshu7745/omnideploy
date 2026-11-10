import { z } from 'zod';
import { ConfigError, type ConfigRepositoryPort, type FileSystemPort, type ProjectConfig } from '../../domain/index.js';

const schema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1).optional(),
  build: z.object({ command: z.string().optional(), output: z.string().optional() }).optional(),
  app: z
    .object({
      start: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      healthCheckPath: z.string().startsWith('/').optional(),
    })
    .optional(),
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

const SCHEMA_URL = 'https://unpkg.com/omnideploy/schema.json';

export class JsonConfigRepository implements ConfigRepositoryPort {
  readonly fileName = 'omnideploy.json';

  constructor(private readonly fs: FileSystemPort) {}

  async load(rootDir: string): Promise<ProjectConfig | null> {
    const raw = await this.fs.readTextIfExists(this.fs.join(rootDir, this.fileName));
    if (raw === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new ConfigError(`${this.fileName} is not valid JSON: ${(e as Error).message}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
      throw new ConfigError(`${this.fileName} is invalid:\n${issues}`, 'Fix the fields above or delete the file and run `omnideploy init`.');
    }
    const { $schema: _ignored, ...config } = parsed.data;
    return config;
  }

  async save(rootDir: string, config: ProjectConfig): Promise<void> {
    // Stable, human-friendly key order: identity, build, runtime, then provider state.
    const { name, build, app, providers, ...rest } = config;
    const ordered = { $schema: SCHEMA_URL, name, build, app, ...rest, providers };
    await this.fs.writeText(this.fs.join(rootDir, this.fileName), JSON.stringify(stripUndefined(ordered), null, 2) + '\n');
  }
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
