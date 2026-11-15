import { DomainError, UnknownProviderError, type CredentialStorePort, type PromptPort } from '../../domain/index.js';
import type { CredentialSubject } from '../services/CredentialResolver.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';

/** Providers plus other token holders (e.g. the `github` repository host). */
function findSubject(providers: ProviderRegistry, extra: readonly CredentialSubject[], id: string): CredentialSubject {
  const other = extra.find((s) => s.id === id);
  if (other) return other;
  if (!providers.ids().includes(id)) throw new UnknownProviderError(id, [...providers.ids(), ...extra.map((s) => s.id)]);
  const p = providers.get(id);
  return { id: p.id, displayName: p.displayName, auth: p.capabilities.auth };
}

export class LoginProvider {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly store: CredentialStorePort,
    private readonly prompt: PromptPort,
    private readonly extra: readonly CredentialSubject[] = [],
  ) {}

  async execute(providerId: string, token?: string): Promise<CredentialSubject> {
    const s = findSubject(this.providers, this.extra, providerId);
    if (!token) {
      if (!this.prompt.interactive) {
        throw new DomainError('No token given.', `Pass --token, or set ${s.auth.envVar}.`, 'MISSING_TOKEN');
      }
      this.prompt.note(`Create a token at:\n${s.auth.tokenUrl}`, `${s.displayName} login`);
      token = await this.prompt.password(`Paste your ${s.displayName} token`);
    }
    token = token.trim();
    if (!token) throw new DomainError('Empty token.', undefined, 'MISSING_TOKEN');
    await this.store.set(s.id, token);
    return s;
  }
}

export class LogoutProvider {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly store: CredentialStorePort,
    private readonly extra: readonly CredentialSubject[] = [],
  ) {}

  async execute(providerId: string): Promise<{ subject: CredentialSubject; removed: boolean }> {
    const subject = findSubject(this.providers, this.extra, providerId);
    return { subject, removed: await this.store.delete(subject.id) };
  }
}
