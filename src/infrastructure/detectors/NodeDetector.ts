import type { DetectionResult, FileSystemPort, ProjectDetector, ProjectProfile } from '../../domain/index.js';
import { extractVersion, firstExisting, hasDockerfile, readJson } from './support.js';

interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

export class NodeDetector implements ProjectDetector {
  readonly id = 'node';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    const pkg = await readJson<PackageJson>(this.fs, this.fs.join(root, 'package.json'));
    if (!pkg) return null;

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const has = (name: string) => name in deps;
    const scripts = pkg.scripts ?? {};
    const pm = await this.packageManager(root);
    const run = (script: string) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`);
    const install = { npm: 'npm ci', pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', bun: 'bun install' }[pm];
    const nvmrc = await this.fs.readTextIfExists(this.fs.join(root, '.nvmrc'));

    const base: ProjectProfile = {
      rootDir: root,
      language: 'node',
      kind: 'server',
      packageManager: pm,
      runtimeVersion: extractVersion(pkg.engines?.node, 1) ?? extractVersion(nvmrc, 1) ?? '22',
      port: 3000,
      hasDockerfile: await hasDockerfile(this.fs, root),
      meta: { name: pkg.name ?? '', install, lockfile: (await this.lockfile(root)) ?? '' },
    };
    const build = scripts.build ? run('build') : undefined;
    const start = scripts.start ? (pm === 'npm' ? 'npm start' : `${pm} start`) : undefined;
    const staticSite = (framework: string, outputDir: string): DetectionResult => ({
      profile: { ...base, framework, kind: 'static', buildCommand: build, outputDir },
      confidence: 90,
    });
    const server = (framework: string | undefined, startCommand: string | undefined, port = 3000): DetectionResult => ({
      profile: { ...base, framework, kind: 'server', buildCommand: build, startCommand, port },
      confidence: 90,
    });

    if (has('next')) {
      const nextConfig = await this.readFirst(root, ['next.config.js', 'next.config.mjs', 'next.config.ts']);
      if (nextConfig && /output\s*:\s*['"]export['"]/.test(nextConfig)) return staticSite('nextjs', 'out');
      return { profile: { ...base, framework: 'nextjs', kind: 'serverless', buildCommand: build, startCommand: start ?? 'npx next start' }, confidence: 90 };
    }
    if (has('nuxt')) return server('nuxt', 'node .output/server/index.mjs');
    if (has('@sveltejs/kit')) {
      return has('@sveltejs/adapter-static') ? staticSite('sveltekit', 'build') : server('sveltekit', 'node build');
    }
    if (has('@remix-run/node') || has('@remix-run/serve')) return server('remix', start);
    if (has('astro')) return has('@astrojs/node') ? server('astro', 'node ./dist/server/entry.mjs', 4321) : staticSite('astro', 'dist');
    if (has('gatsby')) return staticSite('gatsby', 'public');
    if (has('@angular/core')) return staticSite('angular', `dist/${pkg.name ?? 'app'}/browser`);
    if (has('react-scripts')) return staticSite('create-react-app', 'build');
    if (has('@nestjs/core')) return server('nestjs', scripts['start:prod'] ? run('start:prod') : 'node dist/main');

    for (const fw of ['express', 'fastify', 'koa', 'hono', '@hapi/hapi']) {
      if (has(fw)) return server(fw.replace('@hapi/', ''), start ?? `node ${pkg.main ?? 'index.js'}`);
    }
    if (has('vite')) {
      const viteFw = ['react', 'vue', 'svelte', 'solid-js', 'preact'].find(has);
      return staticSite(viteFw ? `vite-${viteFw.replace('-js', '')}` : 'vite', 'dist');
    }
    if (start) return server(undefined, start);
    if (build) return { ...staticSite('node-static', 'dist'), confidence: 60 };
    return null;
  }

  private async packageManager(root: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
    const lock = await this.lockfile(root);
    if (lock === 'pnpm-lock.yaml') return 'pnpm';
    if (lock === 'yarn.lock') return 'yarn';
    if (lock?.startsWith('bun.lock')) return 'bun';
    return 'npm';
  }

  private lockfile(root: string) {
    return firstExisting(this.fs, root, ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json']);
  }

  private async readFirst(root: string, files: string[]): Promise<string | null> {
    const f = await firstExisting(this.fs, root, files);
    return f ? this.fs.readText(this.fs.join(root, f)) : null;
  }
}
