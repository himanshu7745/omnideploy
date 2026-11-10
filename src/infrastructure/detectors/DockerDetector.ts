import type { DetectionResult, FileSystemPort, ProjectDetector } from '../../domain/index.js';

/** Any project with a Dockerfile can be deployed as a container, even if no language detector matches. */
export class DockerDetector implements ProjectDetector {
  readonly id = 'docker';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    const dockerfile = await this.fs.readTextIfExists(this.fs.join(root, 'Dockerfile'));
    if (dockerfile === null) return null;
    const port = Number(dockerfile.match(/^\s*EXPOSE\s+(\d+)/im)?.[1] ?? 8080);
    return {
      profile: { rootDir: root, language: 'docker', kind: 'server', port, hasDockerfile: true },
      confidence: 20,
    };
  }
}
