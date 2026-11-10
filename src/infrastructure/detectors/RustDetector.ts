import { parse as parseToml } from 'smol-toml';
import type { DetectionResult, FileSystemPort, ProjectDetector } from '../../domain/index.js';
import { extractVersion, hasDockerfile } from './support.js';

export class RustDetector implements ProjectDetector {
  readonly id = 'rust';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    const raw = await this.fs.readTextIfExists(this.fs.join(root, 'Cargo.toml'));
    if (raw === null) return null;
    let cargo: Record<string, any> = {};
    try {
      cargo = parseToml(raw) as Record<string, any>;
    } catch {
      /* fall through with defaults */
    }
    const deps = Object.keys(cargo.dependencies ?? {});
    const framework = ['actix-web', 'axum', 'rocket', 'warp', 'poem'].find((f) => deps.includes(f));
    const binName: string = cargo.bin?.[0]?.name ?? cargo.package?.name ?? 'app';
    const toolchain =
      (await this.fs.readTextIfExists(this.fs.join(root, 'rust-toolchain'))) ??
      (await this.fs.readTextIfExists(this.fs.join(root, 'rust-toolchain.toml')));

    return {
      profile: {
        rootDir: root,
        language: 'rust',
        framework,
        kind: 'server',
        packageManager: 'cargo',
        runtimeVersion: extractVersion(toolchain) ?? '1',
        buildCommand: 'cargo build --release',
        startCommand: `./${binName}`,
        port: 8080,
        hasDockerfile: await hasDockerfile(this.fs, root),
        meta: { name: cargo.package?.name ?? '', binName },
      },
      confidence: framework ? 85 : 70,
    };
  }
}
