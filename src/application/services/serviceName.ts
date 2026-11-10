import { toServiceName, type ProjectConfig, type ProjectProfile } from '../../domain/index.js';

export function resolveServiceName(profile: ProjectProfile, config: ProjectConfig | null): string {
  const raw = config?.name ?? profile.meta?.name ?? profile.rootDir.split(/[\\/]/).filter(Boolean).pop() ?? 'app';
  return toServiceName(raw);
}
