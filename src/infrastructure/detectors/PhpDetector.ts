import type { DetectionResult, FileSystemPort, ProjectDetector } from '../../domain/index.js';
import { extractVersion, hasDockerfile, readJson } from './support.js';

export class PhpDetector implements ProjectDetector {
  readonly id = 'php';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    const composer = await readJson<{ name?: string; require?: Record<string, string> }>(this.fs, this.fs.join(root, 'composer.json'));
    const hasIndex = await this.fs.exists(this.fs.join(root, 'index.php'));
    const hasPublicIndex = await this.fs.exists(this.fs.join(root, 'public', 'index.php'));
    if (!composer && !hasIndex && !hasPublicIndex) return null;

    const req = composer?.require ?? {};
    const framework = 'laravel/framework' in req ? 'laravel' : 'symfony/framework-bundle' in req ? 'symfony' : undefined;
    const docroot = hasPublicIndex || framework ? 'public' : '.';

    return {
      profile: {
        rootDir: root,
        language: 'php',
        framework,
        kind: 'server',
        packageManager: composer ? 'composer' : undefined,
        runtimeVersion: extractVersion(req.php) ?? '8.3',
        startCommand: framework === 'laravel' ? 'php artisan serve --host=0.0.0.0 --port=$PORT' : `php -S 0.0.0.0:$PORT -t ${docroot}`,
        port: 8080,
        hasDockerfile: await hasDockerfile(this.fs, root),
        meta: { name: composer?.name?.split('/').pop() ?? '', docroot, composer: String(Boolean(composer)) },
      },
      confidence: composer ? 80 : 50,
    };
  }
}
