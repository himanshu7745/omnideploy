import type { AppKind } from '../value-objects/AppKind.js';
import type { Framework } from '../value-objects/Framework.js';
import { LANGUAGE_LABELS, type Language } from '../value-objects/Language.js';

/** Everything omnideploy knows about the project being deployed. */
export interface ProjectProfile {
  rootDir: string;
  language: Language;
  framework?: Framework;
  kind: AppKind;
  /** e.g. "21" for Java, "3.12" for Python, "20" for Node. */
  runtimeVersion?: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'poetry' | 'uv' | 'maven' | 'gradle' | 'cargo' | 'bundler' | 'composer' | 'dotnet' | 'go';
  /** Shell command that builds the project, if any. */
  buildCommand?: string;
  /** Shell command that starts a server app. */
  startCommand?: string;
  /** Directory (relative to rootDir) containing static build output. */
  outputDir?: string;
  /** Port a server app listens on by default (the platform's $PORT always wins at runtime). */
  port: number;
  hasDockerfile: boolean;
  /** Language-specific extras for generators (e.g. { buildTool: 'gradle', artifactName: 'app.jar' }). */
  meta?: Record<string, string>;
}

export function describeProfile(p: ProjectProfile): string {
  const parts = [
    LANGUAGE_LABELS[p.language] + (p.runtimeVersion ? ` ${p.runtimeVersion}` : ''),
    p.framework,
    p.kind,
    p.kind === 'static' ? (p.outputDir ? `output: ${p.outputDir}` : undefined) : `port ${p.port}`,
  ];
  return parts.filter(Boolean).join(' · ');
}
