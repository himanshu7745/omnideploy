import {
  MissingCredentialError,
  type CredentialStorePort,
  type DeploymentProvider,
  type PromptPort,
} from '../../domain/index.js';

export interface CredentialSubject {
  id: string;
  displayName: string;
  auth: { envVar: string; tokenUrl: string };
}

/** Token lookup order: env var → credential store → interactive prompt. */
export class CredentialResolver {
  constructor(
    private readonly store: CredentialStorePort,
    private readonly prompt: PromptPort,
  ) {}

  async resolve(provider: DeploymentProvider, opts: { allowPrompt: boolean }): Promise<string> {
    return this.resolveFor({ id: provider.id, displayName: provider.displayName, auth: provider.capabilities.auth }, opts);
  }

  /** Same lookup for anything with an auth spec. `fallback` (e.g. an existing CLI login) is tried before prompting. */
  async resolveFor(
    provider: CredentialSubject,
    opts: { allowPrompt: boolean; fallback?: () => Promise<string | null> },
  ): Promise<string> {
    const { envVar, tokenUrl } = provider.auth;
    const found = await this.store.get(provider.id, envVar);
    if (found) return found.token;
    const fallback = await opts.fallback?.();
    if (fallback) return fallback;

    if (!opts.allowPrompt || !this.prompt.interactive) {
      throw new MissingCredentialError(provider.id, envVar);
    }

    this.prompt.note(`Create a token at:\n${tokenUrl}\n\nIt will be saved for future deploys (or set ${envVar}).`, `${provider.displayName} login`);
    const token = (await this.prompt.password(`Paste your ${provider.displayName} token`)).trim();
    if (!token) throw new MissingCredentialError(provider.id, envVar);
    await this.store.set(provider.id, token);
    return token;
  }
}
