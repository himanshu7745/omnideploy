import type { DetectionResult, FileSystemPort, ProjectDetector } from '../../domain/index.js';
import { hasDockerfile } from './support.js';

/** Plain HTML sites with no build step. Language detectors outrank this. */
export class StaticDetector implements ProjectDetector {
  readonly id = 'static';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    for (const dir of ['.', 'public', 'docs', 'site']) {
      if (await this.fs.exists(this.fs.join(root, dir, 'index.html'))) {
        return {
          profile: {
            rootDir: root,
            language: 'static',
            framework: 'html',
            kind: 'static',
            outputDir: dir,
            port: 8080,
            hasDockerfile: await hasDockerfile(this.fs, root),
          },
          confidence: 40,
        };
      }
    }
    return null;
  }
}
