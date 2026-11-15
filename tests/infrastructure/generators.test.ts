import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DetectProject } from '../../src/application/index.js';
import type { GenerateOptions, ProjectProfile } from '../../src/domain/index.js';
import { builtInDetectors } from '../../src/infrastructure/detectors/index.js';
import { NodeFileSystem } from '../../src/infrastructure/fs/NodeFileSystem.js';
import { DockerfileGenerator } from '../../src/infrastructure/generators/dockerfile/DockerfileGenerator.js';
import { NetlifyTomlGenerator } from '../../src/infrastructure/generators/provider-config/netlify.js';
import { RailwayJsonGenerator } from '../../src/infrastructure/generators/provider-config/railway.js';
import { RenderYamlGenerator, renderUsesDocker } from '../../src/infrastructure/generators/provider-config/render.js';
import { VercelJsonGenerator } from '../../src/infrastructure/generators/provider-config/vercel.js';
import { MemoryConfigRepo } from '../helpers/fakes.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const profileOf = async (name: string) =>
  (await new DetectProject(builtInDetectors(new NodeFileSystem()), new MemoryConfigRepo()).execute(join(FIXTURES, name))).profile;
const opts: GenerateOptions = { providerId: 'render', providerOptions: {}, serviceName: 'demo' };

describe('Dockerfile templates', () => {
  const gen = new DockerfileGenerator();

  it.each(['spring-maven', 'spring-gradle', 'vite', 'next', 'express', 'django', 'fastapi', 'go', 'rust', 'rails', 'laravel', 'dotnet', 'plain-html'])(
    '%s',
    async (fixture) => {
      const profile = await profileOf(fixture);
      expect(gen.supports(profile)).toBe(true);
      const { contents } = gen.generate(profile);
      // Invariants every template must satisfy.
      expect(contents).toMatch(/^# syntax=docker\/dockerfile:1/);
      expect(contents.match(/^FROM /gm)!.length).toBeGreaterThanOrEqual(2); // multi-stage
      expect(contents).toMatch(/^USER /m); // non-root
      expect(contents).toMatch(/PORT/);
      expect(contents).toMatchSnapshot();
    },
  );

  it('does not template projects that bring their own Dockerfile', async () => {
    expect(gen.supports(await profileOf('dockerfile'))).toBe(false);
  });

  it('pins the detected Java version in both stages', async () => {
    const { contents } = gen.generate(await profileOf('spring-maven'));
    expect(contents).toContain('FROM maven:3.9-eclipse-temurin-21 AS build');
    expect(contents).toContain('FROM eclipse-temurin:21-jre');
    expect(contents).toContain('-Dserver.port=$PORT');
  });
});

describe('render.yaml', () => {
  const gen = new RenderYamlGenerator();
  const services = (p: ProjectProfile) => parseYaml(gen.generate(p, opts).contents).services;

  it('uses the docker runtime for Java (Render has no native Java runtime)', async () => {
    const java = await profileOf('spring-maven');
    expect(renderUsesDocker(java)).toBe(true);
    expect(services(java)[0]).toMatchObject({ type: 'web', name: 'demo', runtime: 'docker', dockerfilePath: './Dockerfile', healthCheckPath: '/' });
  });

  it('uses the native runtime for Python', async () => {
    const svc = services(await profileOf('django'))[0];
    expect(svc).toMatchObject({ runtime: 'python', startCommand: 'gunicorn mysite.wsgi:application --bind 0.0.0.0:$PORT' });
    expect(svc.buildCommand).toContain('pip install -r requirements.txt');
    expect(svc.buildCommand).toContain('pip install gunicorn');
  });

  it('installs dependencies before building a static site (Render does not)', async () => {
    const vite = await profileOf('vite');
    const withLock = { ...vite, packageManager: 'npm' as const, meta: { ...vite.meta, install: 'npm ci', lockfile: 'package-lock.json' } };
    expect(services(withLock)[0].buildCommand).toBe('npm ci && npm run build');
    // npm ci needs a lockfile; without one, fall back to a plain install.
    const noLock = { ...withLock, meta: { ...withLock.meta, lockfile: '' } };
    expect(services(noLock)[0].buildCommand).toBe('npm install && npm run build');
    expect(services({ ...noLock, packageManager: 'pnpm' as const })[0].buildCommand).toBe('pnpm install && npm run build');
  });

  it('uses app.healthCheckPath for server apps', async () => {
    const java = { ...(await profileOf('spring-maven')), healthCheckPath: '/actuator/health' };
    expect(services(java)[0].healthCheckPath).toBe('/actuator/health');
  });

  it('publishes static sites with an SPA rewrite', async () => {
    expect(services(await profileOf('vite'))[0]).toMatchObject({
      runtime: 'static',
      staticPublishPath: './dist',
      routes: [{ type: 'rewrite', source: '/*', destination: '/index.html' }],
    });
  });
});

describe('other provider configs', () => {
  it('railway.json builds from the Dockerfile', async () => {
    const json = JSON.parse(new RailwayJsonGenerator().generate(await profileOf('go'), opts).contents);
    expect(json.build).toEqual({ builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' });
  });

  it('vercel.json is only generated for SPAs', async () => {
    const gen = new VercelJsonGenerator();
    expect(gen.supports(await profileOf('vite'))).toBe(true);
    expect(gen.supports(await profileOf('next'))).toBe(false);
  });

  it('netlify.toml has build settings and the SPA redirect', async () => {
    const { contents } = new NetlifyTomlGenerator().generate(await profileOf('vite'));
    expect(contents).toContain('publish = "dist"');
    expect(contents).toContain('command = "npm run build"');
    expect(contents).toContain('to = "/index.html"');
  });
});
