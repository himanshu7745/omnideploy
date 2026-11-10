import type { DetectionResult, FileSystemPort, ProjectDetector } from '../../domain/index.js';
import { extractVersion, hasDockerfile } from './support.js';

export class GoDetector implements ProjectDetector {
  readonly id = 'go';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    const gomod = await this.fs.readTextIfExists(this.fs.join(root, 'go.mod'));
    if (gomod === null) return null;
    const module = gomod.match(/^module\s+(\S+)/m)?.[1] ?? '';
    const framework = [
      ['github.com/gin-gonic/gin', 'gin'],
      ['github.com/labstack/echo', 'echo'],
      ['github.com/gofiber/fiber', 'fiber'],
      ['github.com/go-chi/chi', 'chi'],
    ].find(([mod]) => gomod.includes(mod!))?.[1];

    let mainPath = '.';
    if (!(await this.fs.exists(this.fs.join(root, 'main.go')))) {
      const cmds = await this.fs.list(this.fs.join(root, 'cmd'));
      for (const c of cmds) {
        if (await this.fs.exists(this.fs.join(root, 'cmd', c, 'main.go'))) {
          mainPath = `./cmd/${c}`;
          break;
        }
      }
    }

    return {
      profile: {
        rootDir: root,
        language: 'go',
        framework,
        kind: 'server',
        packageManager: 'go',
        runtimeVersion: extractVersion(gomod.match(/^go\s+([\d.]+)/m)?.[1]) ?? '1.23',
        buildCommand: `go build -o app ${mainPath}`,
        startCommand: './app',
        port: 8080,
        hasDockerfile: await hasDockerfile(this.fs, root),
        meta: { name: module.split('/').pop() ?? '', mainPath },
      },
      confidence: 85,
    };
  }
}
