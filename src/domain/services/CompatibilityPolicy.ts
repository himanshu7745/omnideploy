import type { ProjectProfile } from '../entities/ProjectProfile.js';
import type { ProviderCapabilities } from '../entities/ProviderCapabilities.js';
import { LANGUAGE_LABELS } from '../value-objects/Language.js';

export type Compatibility = { ok: true } | { ok: false; reason: string };

interface ProviderLike {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
}

/** Can a provider with these capabilities host this project? Pure function. */
export function checkCompatibility(profile: ProjectProfile, caps: ProviderCapabilities): Compatibility {
  if (profile.kind === 'static') {
    return caps.kinds.includes('static')
      ? { ok: true }
      : { ok: false, reason: 'does not host static sites' };
  }

  if (profile.framework && caps.serverlessFrameworks?.includes(profile.framework)) {
    return { ok: true };
  }

  // Serverless frameworks (e.g. Next.js) can also run as a regular server elsewhere.
  if (!caps.kinds.includes('server')) {
    const what = profile.framework ?? LANGUAGE_LABELS[profile.language];
    return {
      ok: false,
      reason: !caps.kinds.includes('static')
        ? `cannot run ${what} apps`
        : caps.serverlessFrameworks?.length
          ? `only hosts static sites and ${listOf(caps.serverlessFrameworks)} apps, not ${what} servers`
          : `only hosts static sites, not ${what} servers`,
    };
  }

  if (caps.serverLanguages === 'any') return { ok: true };
  if (caps.serverLanguages.includes(profile.language)) return { ok: true };
  return { ok: false, reason: `cannot run ${LANGUAGE_LABELS[profile.language]} server apps` };
}

/** Providers (other than `exclude`) that can host this project. */
export function compatibleProviders<P extends ProviderLike>(
  profile: ProjectProfile,
  providers: readonly P[],
  exclude?: string,
): P[] {
  return providers.filter((p) => p.id !== exclude && checkCompatibility(profile, p.capabilities).ok);
}

export function suggestAlternatives(profile: ProjectProfile, providers: readonly ProviderLike[], exclude: string): string {
  const alts = compatibleProviders(profile, providers, exclude).map((p) => p.displayName);
  return alts.length > 0 ? `Deploy to ${listOf(alts)} instead.` : 'No available provider can host this project yet.';
}

function listOf(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}
