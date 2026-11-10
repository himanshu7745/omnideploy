import {
  checkCompatibility,
  type CredentialStorePort,
  type ProcessRunnerPort,
  type ProjectProfile,
} from '../../domain/index.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';

export interface ProviderRow {
  id: string;
  displayName: string;
  hosts: string;
  auth: 'env' | 'store' | null;
  cli: { bin: string; installed: boolean; install: string } | null;
  compatibility?: { ok: boolean; reason?: string };
}

export class ListProviders {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly store: CredentialStorePort,
    private readonly process: ProcessRunnerPort,
  ) {}

  async execute(profile?: ProjectProfile): Promise<ProviderRow[]> {
    return Promise.all(
      this.providers.all().map(async (p): Promise<ProviderRow> => {
        const cred = await this.store.get(p.id, p.capabilities.auth.envVar);
        const req = p.capabilities.requiredCli;
        const c = profile ? checkCompatibility(profile, p.capabilities) : undefined;
        return {
          id: p.id,
          displayName: p.displayName,
          hosts: p.capabilities.kinds.join(', '),
          auth: cred?.source ?? null,
          cli: req ? { bin: req.bin, installed: await this.process.has(req.bin), install: req.install } : null,
          compatibility: c && (c.ok ? { ok: true } : { ok: false, reason: c.reason }),
        };
      }),
    );
  }
}
