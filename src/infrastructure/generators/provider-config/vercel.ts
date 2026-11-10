import { isSinglePageApp, type ArtifactGenerator, type DeploymentArtifact, type ProjectProfile } from '../../../domain/index.js';

/** Only needed for client-side routed SPAs; frameworks like Next.js need no vercel.json. */
export class VercelJsonGenerator implements ArtifactGenerator {
  readonly id = 'vercel-json';
  readonly path = 'vercel.json';

  supports(profile: ProjectProfile): boolean {
    return isSinglePageApp(profile);
  }

  generate(): DeploymentArtifact {
    const config = {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      rewrites: [{ source: '/(.*)', destination: '/index.html' }],
    };
    return { id: this.id, path: this.path, contents: JSON.stringify(config, null, 2) + '\n', description: 'SPA rewrite so client-side routes work on refresh' };
  }
}
