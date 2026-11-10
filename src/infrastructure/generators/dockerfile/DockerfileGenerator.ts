import type { ArtifactGenerator, DeploymentArtifact, ProjectProfile } from '../../../domain/index.js';
import { LANGUAGE_LABELS } from '../../../domain/index.js';
import { DOCKER_TEMPLATES, dockerignoreFor } from './templates.js';

export class DockerfileGenerator implements ArtifactGenerator {
  readonly id = 'dockerfile';
  readonly path = 'Dockerfile';

  supports(profile: ProjectProfile): boolean {
    return profile.language in DOCKER_TEMPLATES;
  }

  generate(profile: ProjectProfile): DeploymentArtifact {
    const template = DOCKER_TEMPLATES[profile.language]!;
    return {
      id: this.id,
      path: this.path,
      contents: template(profile),
      description: `multi-stage ${LANGUAGE_LABELS[profile.language]}${profile.framework ? ` (${profile.framework})` : ''} image`,
    };
  }
}

export class DockerignoreGenerator implements ArtifactGenerator {
  readonly id = 'dockerignore';
  readonly path = '.dockerignore';

  supports(): boolean {
    return true;
  }

  generate(profile: ProjectProfile): DeploymentArtifact {
    return { id: this.id, path: this.path, contents: dockerignoreFor(profile), description: 'keeps the Docker build context small' };
  }
}
