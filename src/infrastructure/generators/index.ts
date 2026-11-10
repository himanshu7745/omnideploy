import type { ArtifactGenerator } from '../../domain/index.js';
import { DockerfileGenerator, DockerignoreGenerator } from './dockerfile/DockerfileGenerator.js';
import { NetlifyTomlGenerator } from './provider-config/netlify.js';
import { RailwayJsonGenerator } from './provider-config/railway.js';
import { RenderYamlGenerator } from './provider-config/render.js';
import { VercelJsonGenerator } from './provider-config/vercel.js';

export function builtInGenerators(): ArtifactGenerator[] {
  return [
    new DockerfileGenerator(),
    new DockerignoreGenerator(),
    new RenderYamlGenerator(),
    new RailwayJsonGenerator(),
    new VercelJsonGenerator(),
    new NetlifyTomlGenerator(),
  ];
}
