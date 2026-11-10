import type { ArtifactGenerator, DeploymentArtifact, GenerateOptions, ProjectProfile } from '../../../domain/index.js';

export class RailwayJsonGenerator implements ArtifactGenerator {
  readonly id = 'railway-json';
  readonly path = 'railway.json';

  supports(): boolean {
    return true;
  }

  generate(p: ProjectProfile, opts: GenerateOptions): DeploymentArtifact {
    const config = {
      $schema: 'https://railway.com/railway.schema.json',
      build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
      deploy: {
        healthcheckPath: opts.healthCheckPath ?? '/',
        healthcheckTimeout: 300,
        restartPolicyType: 'ON_FAILURE',
        restartPolicyMaxRetries: 5,
      },
    };
    return {
      id: this.id,
      path: this.path,
      contents: JSON.stringify(config, null, 2) + '\n',
      description: 'Railway config (build from Dockerfile, health check, restart policy)',
    };
  }
}
