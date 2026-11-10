import { UnknownProviderError, type DeploymentProvider } from '../../domain/index.js';

export class ProviderRegistry {
  private readonly byId: Map<string, DeploymentProvider>;

  constructor(providers: readonly DeploymentProvider[]) {
    this.byId = new Map(providers.map((p) => [p.id, p]));
  }

  all(): DeploymentProvider[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  get(id: string): DeploymentProvider {
    const p = this.byId.get(id);
    if (!p) throw new UnknownProviderError(id, this.ids());
    return p;
  }
}
