import {
  DomainError,
  formatDotenvLine,
  parseDotenv,
  PLATFORM_MANAGED_VARS,
  pointsToLocalhost,
  requiredPlaceholders,
  type FileSystemPort,
  type LoggerPort,
  type ProjectConfig,
  type PromptPort,
} from '../../domain/index.js';
import type { SecretGuard } from './SecretGuard.js';

export const ENV_FILE = '.env.production';

/** Files whose variable *names* tell us what the app expects. Their values are never used. */
const TEMPLATES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', '.env'];
/** JVM config where `${VAR}` without a default means the app won't start without VAR. */
const JVM_CONFIG = ['application', 'application-prod', 'application-production'].flatMap((n) =>
  ['yml', 'yaml', 'properties'].flatMap((ext) => [`src/main/resources/${n}.${ext}`, `${n}.${ext}`, `config/${n}.${ext}`]),
);

export interface EnvInspection {
  /** Contents of .env.production, or null if it doesn't exist. */
  text: string | null;
  parsed: Record<string, string>;
  optional: Set<string>;
  missing: string[];
  empty: string[];
  /** Human-readable problem, if a required variable is missing or empty. */
  problem?: string;
  /** false if env.sync is turned off in omnideploy.json. */
  enabled: boolean;
}

export interface ProductionEnv {
  /** Variables to set on the platform and pass to local builds. */
  vars: Record<string, string>;
  /** True if .env.production exists. */
  found: boolean;
}

/**
 * `.env.production` is the single source of truth for production variables. This reads it, works out which
 * variables the app needs, and refuses to continue when one is missing or empty — a deploy without them
 * "succeeds" but the app doesn't work.
 */
export class ProductionEnvironment {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly prompt: PromptPort,
    private readonly logger: LoggerPort,
    private readonly secrets: SecretGuard,
  ) {}

  /** Read-only check (used by `doctor`): what's in .env.production and what's missing. */
  async inspect(rootDir: string, config: ProjectConfig | null): Promise<EnvInspection> {
    const text = await this.fs.readTextIfExists(this.fs.join(rootDir, ENV_FILE));
    const parsed = text === null ? {} : parseDotenv(text);
    const optional = new Set(config?.env?.optional ?? []);
    const expected = await this.expectedVariables(rootDir);
    const missing = [...expected.keys()].filter((k) => !(k in parsed) && !optional.has(k) && !PLATFORM_MANAGED_VARS.has(k));
    const empty = Object.entries(parsed)
      .filter(([k, v]) => v === '' && !optional.has(k) && !PLATFORM_MANAGED_VARS.has(k))
      .map(([k]) => k);
    const problem = missing.length > 0 || empty.length > 0 ? this.describe(text !== null, missing, empty, expected) : undefined;
    return { text, parsed, optional, missing, empty, problem, enabled: config?.env?.sync !== false };
  }

  async load(rootDir: string, config: ProjectConfig | null, opts: { yes?: boolean; dryRun?: boolean; forWhat: string }): Promise<ProductionEnv> {
    if (config?.env?.sync === false) return { vars: {}, found: false };
    const { text, parsed, optional, missing, empty, problem } = await this.inspect(rootDir, config);

    if (problem) {
      if (opts.dryRun) this.logger.warn(problem);
      else await this.refuse(rootDir, text, missing, empty, problem, opts);
    }

    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (PLATFORM_MANAGED_VARS.has(k)) {
        this.logger.info(`Ignoring ${k} from ${ENV_FILE}: the platform sets it.`);
        continue;
      }
      if (v === '' && optional.has(k)) continue;
      vars[k] = v;
    }
    const local = Object.entries(vars).filter(([, v]) => pointsToLocalhost(v)).map(([k]) => k);
    if (local.length > 0) {
      this.logger.warn(
        `${local.join(', ')} in ${ENV_FILE} point${local.length === 1 ? 's' : ''} to localhost, which on ${opts.forWhat} is the server itself, not your machine. Use the hosted service's address.`,
      );
    }
    if (Object.keys(vars).length > 0) this.logger.info(`Using ${Object.keys(vars).length} variable(s) from ${ENV_FILE}: ${Object.keys(vars).join(', ')}`);
    return { vars, found: text !== null };
  }

  /** Variable name → where we learned the app needs it. */
  private async expectedVariables(rootDir: string): Promise<Map<string, string>> {
    const expected = new Map<string, string>();
    for (const file of TEMPLATES) {
      const text = await this.fs.readTextIfExists(this.fs.join(rootDir, file));
      if (text) for (const k of Object.keys(parseDotenv(text))) if (!expected.has(k)) expected.set(k, file);
    }
    for (const file of JVM_CONFIG) {
      const text = await this.fs.readTextIfExists(this.fs.join(rootDir, file));
      if (text) for (const k of requiredPlaceholders(text)) if (!expected.has(k)) expected.set(k, file);
    }
    return expected;
  }

  private describe(exists: boolean, missing: string[], empty: string[], expected: Map<string, string>): string {
    const sources = [...new Set(missing.map((k) => expected.get(k)!))];
    const parts = [];
    if (missing.length > 0) {
      parts.push(
        `${exists ? `${ENV_FILE} is missing` : `there is no ${ENV_FILE} for`} ${missing.join(', ')} (the app expects ${missing.length === 1 ? 'it' : 'them'}, see ${sources.join(', ')})`,
      );
    }
    if (empty.length > 0) parts.push(`${empty.join(', ')} ${empty.length === 1 ? 'is' : 'are'} empty in ${ENV_FILE}`);
    return `The app needs production environment variables, but ${parts.join('; and ')}.`;
  }

  private async refuse(rootDir: string, text: string | null, missing: string[], empty: string[], problem: string, opts: { yes?: boolean }): Promise<never> {
    const hint =
      `Put the production values in ${ENV_FILE} in the project root (KEY=value per line). It is never committed or uploaded; ` +
      'omnideploy sets the values on the provider. If a variable is optional, list it under env.optional in omnideploy.json.';
    if (this.prompt.interactive && !opts.yes && missing.length > 0) {
      const create = await this.prompt.confirm(
        text === null
          ? `Create ${ENV_FILE} with ${missing.join(', ')} for you to fill in?`
          : `Add ${missing.join(', ')} to ${ENV_FILE} for you to fill in?`,
        true,
      );
      if (create) {
        await this.writeTemplate(rootDir, text, missing);
        throw new DomainError(
          `${text === null ? 'Created' : 'Updated'} ${ENV_FILE} — fill in ${[...missing, ...empty].join(', ')}, then deploy again.`,
          `Open ${ENV_FILE} and set each value. It is git-ignored, so the values stay on your machine and the provider.`,
          'ENV_INCOMPLETE',
        );
      }
    }
    throw new DomainError(problem, hint, 'ENV_INCOMPLETE');
  }

  private async writeTemplate(rootDir: string, text: string | null, missing: string[]): Promise<void> {
    const header = text === null ? `# Production environment variables — the single source of truth for deploys.\n# Never committed or uploaded: omnideploy sets these on the provider.\n` : '';
    const sep = text && !text.endsWith('\n') ? '\n' : '';
    await this.fs.writeText(this.fs.join(rootDir, ENV_FILE), `${text ?? ''}${sep}${header}${missing.map((k) => formatDotenvLine(k, '')).join('\n')}\n`);
    await this.secrets.addToGitignore(rootDir, [ENV_FILE]);
  }
}
