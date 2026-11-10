import {
  MissingCredentialError,
  type CredentialStorePort,
  type DeploymentProvider,
  type PromptPort,
} from '../../domain/index.js';

/** Token lookup order: env var → credential store → interactive prompt. */
export class CredentialResolver {
  constructor(
    private readonly store: CredentialStorePort,
    private readonly prompt: PromptPort,
  ) {}

  async resolve(provider: DeploymentProvider, opts: { allowPrompt: boolean }): Promise<string> {
    const { envVar, tokenUrl } = provider.capabilities.auth;
    const found = await this.store.get(provider.id, envVar);
    if (found) return found.token;

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
