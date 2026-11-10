/** Identifier of a kind of deployment file a provider may need. */
export type ArtifactId =
  | 'dockerfile'
  | 'dockerignore'
  | 'render-yaml'
  | 'railway-json'
  | 'vercel-json'
  | 'netlify-toml'
  | (string & {});

/** A generated file, not yet written to disk. */
export interface DeploymentArtifact {
  id: ArtifactId;
  /** Path relative to the project root. */
  path: string;
  contents: string;
  description: string;
}
