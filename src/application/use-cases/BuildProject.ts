import {
  BuildError,
  DomainError,
  type FileSystemPort,
  type LoggerPort,
  type ProcessRunnerPort,
  type ProjectProfile,
  type Spinner,
} from '../../domain/index.js';

/**
 * Builds static sites locally and returns the directory to upload.
 * Server and serverless apps are built remotely by the provider, so their source root is returned.
 */
export class BuildProject {
  constructor(
    private readonly process: ProcessRunnerPort,
    private readonly fs: FileSystemPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(profile: ProjectProfile, opts: { skipBuild?: boolean; spinner?: Spinner }): Promise<string> {
    if (profile.kind !== 'static') return profile.rootDir;

    if (profile.buildCommand && !opts.skipBuild) {
      opts.spinner?.start(`Building: ${profile.buildCommand}`);
      const res = await this.process.shell(profile.buildCommand, { cwd: profile.rootDir, env: { CI: '1' } });
      if (res.exitCode !== 0) {
        opts.spinner?.stop('Build failed', false);
        const tail = (res.stderr || res.stdout).trim().split('\n').slice(-15).join('\n');
        throw new BuildError(profile.buildCommand, tail);
      }
      opts.spinner?.stop('Build complete');
    }

    const out = this.fs.resolve(profile.rootDir, profile.outputDir ?? '.');
    if (!(await this.fs.exists(out))) {
      throw new DomainError(
        `Build output directory "${profile.outputDir}" does not exist.`,
        profile.buildCommand && opts.skipBuild
          ? 'Run the build first, or drop --no-build.'
          : 'Set build.output in omnideploy.json to the folder your build produces.',
        'MISSING_OUTPUT',
      );
    }
    this.logger.debug(`Deploying files from ${out}`);
    return out;
  }
}
