import { DomainError, type CredentialStorePort, type PromptPort } from '../../domain/index.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';

export class LoginProvider {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly store: CredentialStorePort,
    private readonly prompt: PromptPort,
  ) {}

  async execute(providerId: string, token?: string): Promise<void> {
    const p = this.providers.get(providerId);
    if (!token) {
      if (!this.prompt.interactive) {
        throw new DomainError('No token given.', `Pass --token, or set ${p.capabilities.auth.envVar}.`, 'MISSING_TOKEN');
      }
      this.prompt.note(`Create a token at:\n${p.capabilities.auth.tokenUrl}`, `${p.displayName} login`);
      token = await this.prompt.password(`Paste your ${p.displayName} token`);
    }
    token = token.trim();
    if (!token) throw new DomainError('Empty token.', undefined, 'MISSING_TOKEN');
    await this.store.set(p.id, token);
  }
}

export class LogoutProvider {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly store: CredentialStorePort,
  ) {}

  async execute(providerId: string): Promise<boolean> {
    return this.store.delete(this.providers.get(providerId).id);
  }
}
