import type { Deployment, DeploymentStatus } from '../entities/Deployment.js';
import type { ArtifactId } from '../entities/DeploymentArtifact.js';
import type { ProjectProfile } from '../entities/ProjectProfile.js';
import type { ProviderOptions } from '../entities/ProjectConfig.js';
import type { ProviderCapabilities } from '../entities/ProviderCapabilities.js';
import type { LoggerPort } from './LoggerPort.js';

export interface DeployContext {
  profile: ProjectProfile;
  options: ProviderOptions;
  token: string;
  /** Absolute path of the static output directory (static apps) or project root (server apps). */
  sourceDir: string;
  production: boolean;
  serviceName: string;
  /** Commit omnideploy pushed in this run (git-based providers may already be auto-deploying it). */
  pushedCommit?: string;
  logger: LoggerPort;
  /** Report progress to the spinner. */
  progress(message: string): void;
}

export interface ProviderContext {
  options: ProviderOptions;
  token: string;
  profile?: ProjectProfile;
}

/** A hosting platform. Implementations live in infrastructure/providers. */
export interface DeploymentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** Files that must exist in the project before deploying this profile here. */
  requiredArtifacts(profile: ProjectProfile): ArtifactId[];
  /** Provider-specific preflight (git remote present, CLI installed, ...). Throw DomainError on failure. */
  validate(ctx: ProviderContext & { profile: ProjectProfile; rootDir: string }): Promise<void>;
  deploy(ctx: DeployContext): Promise<Deployment>;
  status?(ctx: ProviderContext, deploymentId?: string): Promise<DeploymentStatus>;
}
