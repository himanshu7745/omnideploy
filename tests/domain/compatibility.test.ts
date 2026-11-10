import { describe, expect, it } from 'vitest';
import {
  checkCompatibility,
  isSinglePageApp,
  suggestAlternatives,
  toServiceName,
  type ProjectProfile,
  type ProviderCapabilities,
} from '../../src/domain/index.js';

const caps = (c: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  kinds: ['static'],
  serverLanguages: [],
  buildsFromGit: false,
  auth: { envVar: 'X', tokenUrl: 'u' },
  ...c,
});
const STATIC_HOST = caps({});
const VERCEL = caps({ kinds: ['static', 'serverless'], serverlessFrameworks: ['nextjs', 'nuxt'] });
const CONTAINER_HOST = caps({ kinds: ['static', 'server', 'serverless'], serverLanguages: 'any' });

const profile = (p: Partial<ProjectProfile>): ProjectProfile => ({ rootDir: '/p', language: 'node', kind: 'server', port: 3000, hasDockerfile: false, ...p });

describe('checkCompatibility', () => {
  it('lets any static host serve a static site', () => {
    expect(checkCompatibility(profile({ kind: 'static' }), STATIC_HOST).ok).toBe(true);
  });

  it('rejects server apps on static-only hosts with a clear reason', () => {
    const r = checkCompatibility(profile({ language: 'java', framework: 'spring-boot' }), STATIC_HOST);
    expect(r).toEqual({ ok: false, reason: 'only hosts static sites, not spring-boot servers' });
  });

  it('explains what a serverless platform does host', () => {
    expect(checkCompatibility(profile({ language: 'java', framework: 'spring-boot' }), VERCEL)).toEqual({
      ok: false,
      reason: 'only hosts static sites and nextjs or nuxt apps, not spring-boot servers',
    });
  });

  it('accepts serverless frameworks the provider runs natively', () => {
    expect(checkCompatibility(profile({ kind: 'serverless', framework: 'nextjs' }), VERCEL).ok).toBe(true);
    expect(checkCompatibility(profile({ kind: 'server', framework: 'nuxt' }), VERCEL).ok).toBe(true);
  });

  it('lets container hosts run any language, including serverless frameworks as servers', () => {
    for (const language of ['java', 'go', 'rust', 'php', 'dotnet', 'docker'] as const) {
      expect(checkCompatibility(profile({ language }), CONTAINER_HOST).ok).toBe(true);
    }
    expect(checkCompatibility(profile({ kind: 'serverless', framework: 'nextjs' }), CONTAINER_HOST).ok).toBe(true);
  });

  it('rejects languages outside an explicit allow-list', () => {
    const r = checkCompatibility(profile({ language: 'java' }), caps({ kinds: ['server'], serverLanguages: ['node'] }));
    expect(r).toEqual({ ok: false, reason: 'cannot run Java server apps' });
  });
});

describe('suggestAlternatives', () => {
  it('names the providers that can host the project', () => {
    const providers = [
      { id: 'vercel', displayName: 'Vercel', capabilities: VERCEL },
      { id: 'railway', displayName: 'Railway', capabilities: CONTAINER_HOST },
      { id: 'render', displayName: 'Render', capabilities: CONTAINER_HOST },
    ];
    expect(suggestAlternatives(profile({ language: 'java' }), providers, 'vercel')).toBe('Deploy to Railway or Render instead.');
  });
});

describe('helpers', () => {
  it('slugifies service names', () => {
    expect(toServiceName('@acme/My Cool_App!')).toBe('my-cool-app');
    expect(toServiceName('---')).toBe('app');
  });

  it('identifies client-side routed SPAs', () => {
    expect(isSinglePageApp(profile({ kind: 'static', framework: 'vite-react' }))).toBe(true);
    expect(isSinglePageApp(profile({ kind: 'static', framework: 'html' }))).toBe(false);
    expect(isSinglePageApp(profile({ kind: 'server', framework: 'vite' }))).toBe(false);
  });
});
