import {
  applyConfigOverrides,
  UnsupportedProjectError,
  type ConfigRepositoryPort,
  type DetectionResult,
  type ProjectConfig,
  type ProjectDetector,
  type ProjectProfile,
} from '../../domain/index.js';

export interface DetectProjectResult {
  profile: ProjectProfile;
  config: ProjectConfig | null;
  /** Other matches, best first — useful for `doctor` and debugging. */
  candidates: DetectionResult[];
}

/** Runs every detector, keeps the highest-confidence match, then applies omnideploy.json overrides. */
export class DetectProject {
  constructor(
    private readonly detectors: readonly ProjectDetector[],
    private readonly configRepo: ConfigRepositoryPort,
  ) {}

  async execute(rootDir: string): Promise<DetectProjectResult> {
    const [config, results] = await Promise.all([
      this.configRepo.load(rootDir),
      Promise.all(this.detectors.map((d) => d.detect(rootDir))),
    ]);
    const candidates = results
      .filter((r): r is DetectionResult => r !== null)
      .sort((a, b) => b.confidence - a.confidence);

    const best = candidates[0];
    if (!best) {
      // Config alone can describe a project the detectors don't know about.
      if (config?.app?.start || config?.build?.output) {
        const profile = applyConfigOverrides(
          { rootDir, language: 'docker', kind: config.app?.start ? 'server' : 'static', port: 8080, hasDockerfile: false },
          config,
        );
        return { profile, config, candidates };
      }
      throw new UnsupportedProjectError(rootDir);
    }

    return { profile: applyConfigOverrides(best.profile, config), config, candidates };
  }
}
