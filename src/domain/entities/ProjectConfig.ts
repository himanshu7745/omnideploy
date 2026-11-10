import type { ProjectProfile } from './ProjectProfile.js';

/** Contents of omnideploy.json — user overrides plus provider state persisted between deploys. */
export interface ProjectConfig {
  /** Service/site name used when creating apps on providers. */
  name?: string;
  build?: { command?: string; output?: string };
  app?: { start?: string; port?: number; healthCheckPath?: string };
  providers: Record<string, ProviderOptions>;
}

export type ProviderOptions = Record<string, unknown>;

export const emptyConfig = (): ProjectConfig => ({ providers: {} });

/** User config always overrides detected values. */
export function applyConfigOverrides(profile: ProjectProfile, config: ProjectConfig | null): ProjectProfile {
  if (!config) return profile;
  return {
    ...profile,
    buildCommand: config.build?.command ?? profile.buildCommand,
    outputDir: config.build?.output ?? profile.outputDir,
    startCommand: config.app?.start ?? profile.startCommand,
    port: config.app?.port ?? profile.port,
  };
}
