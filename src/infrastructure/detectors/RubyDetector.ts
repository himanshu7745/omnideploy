import type { DetectionResult, FileSystemPort, ProjectDetector } from '../../domain/index.js';
import { extractVersion, hasDockerfile } from './support.js';

export class RubyDetector implements ProjectDetector {
  readonly id = 'ruby';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    const gemfile = await this.fs.readTextIfExists(this.fs.join(root, 'Gemfile'));
    if (gemfile === null) return null;
    const has = (gem: string) => new RegExp(`^\\s*gem\\s+['"]${gem}['"]`, 'm').test(gemfile);
    const version =
      extractVersion(await this.fs.readTextIfExists(this.fs.join(root, '.ruby-version'))) ??
      extractVersion(gemfile.match(/^\s*ruby\s+['"]([^'"]+)/m)?.[1]) ??
      '3.3';
    const rails = has('rails');

    return {
      profile: {
        rootDir: root,
        language: 'ruby',
        framework: rails ? 'rails' : has('sinatra') ? 'sinatra' : undefined,
        kind: 'server',
        packageManager: 'bundler',
        runtimeVersion: version,
        buildCommand: rails ? 'bundle exec rails assets:precompile' : undefined,
        startCommand: rails ? 'bundle exec rails server -b 0.0.0.0 -p $PORT' : 'bundle exec rackup -o 0.0.0.0 -p $PORT',
        port: 3000,
        hasDockerfile: await hasDockerfile(this.fs, root),
        meta: { name: '' },
      },
      confidence: 80,
    };
  }
}
