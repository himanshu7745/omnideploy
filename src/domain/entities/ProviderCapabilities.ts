import type { AppKind } from '../value-objects/AppKind.js';
import type { Language } from '../value-objects/Language.js';

export interface ProviderCapabilities {
  /** App kinds this provider can host. */
  kinds: readonly AppKind[];
  /** Languages it can run for server/serverless apps. `any` = anything with a Dockerfile. */
  serverLanguages: readonly Language[] | 'any';
  /** Frameworks it runs natively as serverless (e.g. nextjs on Vercel). */
  serverlessFrameworks?: readonly string[];
  /** True if the provider builds from the git remote rather than uploaded local files. */
  buildsFromGit: boolean;
  /** Required external CLI binary, if any. */
  requiredCli?: { bin: string; install: string };
  auth: { envVar: string; tokenUrl: string };
}
