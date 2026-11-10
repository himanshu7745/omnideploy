import { DomainError, type ConfigRepositoryPort, type DeploymentStatus } from '../../domain/index.js';
import type { CredentialResolver } from '../services/CredentialResolver.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';

export class GetDeploymentStatus {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly credentials: CredentialResolver,
    private readonly configRepo: ConfigRepositoryPort,
  ) {}

  async execute(rootDir: string, providerId: string, deploymentId?: string): Promise<DeploymentStatus> {
    const p = this.providers.get(providerId);
    if (!p.status) throw new DomainError(`${p.displayName} does not support status checks yet.`, undefined, 'UNSUPPORTED');
    const config = await this.configRepo.load(rootDir);
    const token = await this.credentials.resolve(p, { allowPrompt: true });
    return p.status({ options: config?.providers[p.id] ?? {}, token }, deploymentId);
  }
}
