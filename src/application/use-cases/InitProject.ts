import {
  checkCompatibility,
  describeProfile,
  DomainError,
  emptyConfig,
  type ConfigRepositoryPort,
  type LoggerPort,
  type ProjectConfig,
  type ProjectProfile,
  type PromptPort,
} from '../../domain/index.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import { resolveServiceName } from '../services/serviceName.js';
import type { DetectProject } from './DetectProject.js';
import type { GenerateArtifacts } from './GenerateArtifacts.js';

export interface InitRequest {
  rootDir: string;
  providerIds?: string[];
  yes?: boolean;
  force?: boolean;
}

export interface InitResult {
  profile: ProjectProfile;
  config: ProjectConfig;
  providerIds: string[];
  written: string[];
}

export class InitProject {
  constructor(
    private readonly detect: DetectProject,
    private readonly providers: ProviderRegistry,
    private readonly generate: GenerateArtifacts,
    private readonly configRepo: ConfigRepositoryPort,
    private readonly prompt: PromptPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(req: InitRequest): Promise<InitResult> {
    const { profile, config: existing } = await this.detect.execute(req.rootDir);
    this.logger.success(`Detected ${describeProfile(profile)}`);

    const compatible = this.providers.all().filter((p) => checkCompatibility(profile, p.capabilities).ok);
    const incompatible = this.providers.all().filter((p) => !compatible.includes(p));
    if (compatible.length === 0) {
      throw new DomainError('None of the available providers can host this project.', undefined, 'NO_PROVIDER');
    }

    let providerIds = req.providerIds;
    if (providerIds) {
      for (const id of providerIds) {
        const p = this.providers.get(id);
        const c = checkCompatibility(profile, p.capabilities);
        if (!c.ok) this.logger.warn(`${p.displayName} ${c.reason} — skipping.`);
      }
      providerIds = providerIds.filter((id) => compatible.some((p) => p.id === id));
    } else if (req.yes || !this.prompt.interactive) {
      providerIds = compatible.map((p) => p.id);
    } else {
      if (incompatible.length > 0) {
        this.logger.info(
          `Not offered: ${incompatible.map((p) => `${p.displayName} (${(checkCompatibility(profile, p.capabilities) as { reason: string }).reason})`).join('; ')}`,
        );
      }
      providerIds = await this.prompt.multiselect(
        'Where do you want to deploy?',
        compatible.map((p) => ({ value: p.id, label: p.displayName, hint: p.capabilities.kinds.join('/') })),
        Object.keys(existing?.providers ?? {}).filter((id) => compatible.some((p) => p.id === id)),
      );
    }
    if (providerIds.length === 0) throw new DomainError('No providers selected.', undefined, 'NO_PROVIDER');

    const config: ProjectConfig = existing ?? emptyConfig();
    config.name ??= resolveServiceName(profile, existing);
    if (profile.kind === 'static') {
      config.build = { command: profile.buildCommand, output: profile.outputDir, ...config.build };
    } else {
      config.app = { port: profile.port, start: profile.startCommand, ...config.app };
    }
    for (const id of providerIds) config.providers[id] ??= {};

    const { written } = await this.generate.execute({
      profile,
      config,
      providerIds,
      yes: req.yes,
      force: req.force,
    });
    await this.configRepo.save(req.rootDir, config);
    this.logger.success(`Saved ${this.configRepo.fileName}`);

    return { profile, config, providerIds, written };
  }
}
