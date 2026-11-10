import type { ArtifactId, DeploymentArtifact } from '../entities/DeploymentArtifact.js';
import type { ProjectProfile } from '../entities/ProjectProfile.js';
import type { ProviderOptions } from '../entities/ProjectConfig.js';

export interface GenerateOptions {
  providerId: string;
  providerOptions: ProviderOptions;
  serviceName: string;
  healthCheckPath?: string;
}

/** Produces one kind of deployment file (Dockerfile, render.yaml, ...). */
export interface ArtifactGenerator {
  readonly id: ArtifactId;
  /** Relative path the artifact is written to. */
  readonly path: string;
  supports(profile: ProjectProfile): boolean;
  generate(profile: ProjectProfile, opts: GenerateOptions): DeploymentArtifact;
}
