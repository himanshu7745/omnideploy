import {
  DomainError,
  UserCancelledError,
  type ArtifactGenerator,
  type ArtifactId,
  type DeploymentArtifact,
  type FileSystemPort,
  type LoggerPort,
  type ProjectConfig,
  type ProjectProfile,
  type PromptPort,
} from '../../domain/index.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import { resolveServiceName } from '../services/serviceName.js';

export type ArtifactAction = 'create' | 'overwrite' | 'keep';

export interface PlannedArtifact extends DeploymentArtifact {
  action: ArtifactAction;
  providers: string[];
}

export interface GenerateArtifactsRequest {
  profile: ProjectProfile;
  config: ProjectConfig | null;
  providerIds: string[];
  force?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

export interface GenerateArtifactsResult {
  planned: PlannedArtifact[];
  written: string[];
}

/**
 * Works out which deployment files the chosen providers need, renders the missing ones,
 * previews them and writes them after confirmation. Existing files are never overwritten
 * without `force`.
 */
export class GenerateArtifacts {
  constructor(
    private readonly generators: readonly ArtifactGenerator[],
    private readonly providers: ProviderRegistry,
    private readonly fs: FileSystemPort,
    private readonly prompt: PromptPort,
    private readonly logger: LoggerPort,
  ) {}

  async plan(req: GenerateArtifactsRequest): Promise<PlannedArtifact[]> {
    const serviceName = resolveServiceName(req.profile, req.config);
    const byId = new Map<ArtifactId, PlannedArtifact>();

    for (const providerId of req.providerIds) {
      const provider = this.providers.get(providerId);
      for (const id of provider.requiredArtifacts(req.profile)) {
        const existing = byId.get(id);
        if (existing) {
          existing.providers.push(providerId);
          continue;
        }
        const generator = this.generators.find((g) => g.id === id && g.supports(req.profile));
        const exists = await this.fs.exists(this.fs.join(req.profile.rootDir, generator?.path ?? String(id)));
        if (!generator) {
          if (exists) continue; // user-provided file, nothing to generate
          throw new DomainError(
            `${provider.displayName} needs a ${id} for this ${req.profile.language} project, but omnideploy has no template for it.`,
            id === 'dockerfile' ? 'Add a Dockerfile to the project root and run the command again.' : undefined,
            'NO_GENERATOR',
          );
        }
        const artifact = generator.generate(req.profile, {
          providerId,
          providerOptions: req.config?.providers[providerId] ?? {},
          serviceName,
          healthCheckPath: req.config?.app?.healthCheckPath,
        });
        byId.set(id, {
          ...artifact,
          action: exists ? (req.force ? 'overwrite' : 'keep') : 'create',
          providers: [providerId],
        });
      }
    }
    return [...byId.values()];
  }

  async execute(req: GenerateArtifactsRequest): Promise<GenerateArtifactsResult> {
    const planned = await this.plan(req);
    const toWrite = planned.filter((a) => a.action !== 'keep');
    if (toWrite.length === 0) return { planned, written: [] };

    this.prompt.note(
      toWrite
        .map((a) => `${a.action === 'create' ? '+' : '~'} ${a.path}  — ${a.description} (for ${a.providers.join(', ')})`)
        .join('\n'),
      req.dryRun ? 'Would generate' : 'Deployment files to generate',
    );
    if (req.dryRun) return { planned, written: [] };

    if (!req.yes) {
      if (!this.prompt.interactive) {
        throw new DomainError(
          'Deployment files need to be generated, but the terminal is not interactive.',
          'Re-run with --yes to accept, or run `omnideploy generate <provider>` first.',
          'CONFIRMATION_REQUIRED',
        );
      }
      const showPreview = await this.prompt.confirm('Preview file contents first?', false);
      if (showPreview) for (const a of toWrite) this.prompt.note(a.contents, a.path);
      if (!(await this.prompt.confirm('Write these files?', true))) throw new UserCancelledError();
    }

    for (const a of toWrite) {
      await this.fs.writeText(this.fs.join(req.profile.rootDir, a.path), a.contents);
      this.logger.success(`${a.action === 'create' ? 'Created' : 'Updated'} ${a.path}`);
    }
    return { planned, written: toWrite.map((a) => a.path) };
  }
}
