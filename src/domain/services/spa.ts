import type { ProjectProfile } from '../entities/ProjectProfile.js';

const SPA_FRAMEWORKS = /^(vite(-.+)?|create-react-app|angular)$/;

/** Client-side routed apps need all unknown paths rewritten to /index.html. */
export function isSinglePageApp(profile: ProjectProfile): boolean {
  return profile.kind === 'static' && SPA_FRAMEWORKS.test(profile.framework ?? '');
}
