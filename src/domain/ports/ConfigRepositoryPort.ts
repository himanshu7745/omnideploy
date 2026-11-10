import type { ProjectConfig } from '../entities/ProjectConfig.js';

export interface ConfigRepositoryPort {
  readonly fileName: string;
  load(rootDir: string): Promise<ProjectConfig | null>;
  save(rootDir: string, config: ProjectConfig): Promise<void>;
}
