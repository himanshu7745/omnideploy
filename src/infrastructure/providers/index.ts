import type { DeploymentProvider, FileSystemPort, GitPort, HttpClientPort, ProcessRunnerPort } from '../../domain/index.js';
import { GitHubPagesProvider } from './GitHubPagesProvider.js';
import { NetlifyProvider } from './NetlifyProvider.js';
import { RailwayProvider } from './RailwayProvider.js';
import { RenderProvider } from './RenderProvider.js';
import { VercelProvider } from './VercelProvider.js';

export interface ProviderDeps {
  http: HttpClientPort;
  fs: FileSystemPort;
  git: GitPort;
  proc: ProcessRunnerPort;
}

export function builtInProviders({ http, fs, git, proc }: ProviderDeps): DeploymentProvider[] {
  return [
    new VercelProvider(http, fs),
    new NetlifyProvider(http, fs),
    new GitHubPagesProvider(http, fs, git),
    new RailwayProvider(proc),
    new RenderProvider(http, git),
  ];
}
