import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BuildProject,
  CredentialResolver,
  DeployProject,
  DetectProject,
  DoctorCheck,
  GenerateArtifacts,
  GetDeploymentStatus,
  InitProject,
  ListProviders,
  LoginProvider,
  LogoutProvider,
  ProviderRegistry,
  RepositoryBootstrapper,
  SecretGuard,
  ProductionEnvironment,
} from '../application/index.js';
import { JsonConfigRepository } from '../infrastructure/config/JsonConfigRepository.js';
import { FileCredentialStore } from '../infrastructure/credentials/FileCredentialStore.js';
import { builtInDetectors } from '../infrastructure/detectors/index.js';
import { NodeFileSystem } from '../infrastructure/fs/NodeFileSystem.js';
import { builtInGenerators } from '../infrastructure/generators/index.js';
import { CliGit } from '../infrastructure/git/CliGit.js';
import { GitHubRepositoryHost } from '../infrastructure/git/GitHubRepositoryHost.js';
import { FetchHttpClient } from '../infrastructure/http/FetchHttpClient.js';
import { ExecaProcessRunner } from '../infrastructure/process/ExecaProcessRunner.js';
import { SystemBrowser } from '../infrastructure/process/SystemBrowser.js';
import { builtInProviders } from '../infrastructure/providers/index.js';
import { ClackPrompt } from './presenters/ClackPrompt.js';
import { ConsoleLogger } from './presenters/ConsoleLogger.js';

export interface ContainerOptions {
  debug: boolean;
  interactive: boolean;
  version: string;
}

export function credentialsPath(): string {
  const base =
    process.env.OMNIDEPLOY_CONFIG_DIR ??
    (process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'omnideploy')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'omnideploy'));
  return join(base, 'credentials.json');
}

/** Composition root: the only place that knows about concrete adapters. */
export function createContainer(opts: ContainerOptions) {
  const fs = new NodeFileSystem();
  const proc = new ExecaProcessRunner();
  const http = new FetchHttpClient({ userAgent: `omnideploy/${opts.version}` });
  const git = new CliGit(proc);
  const store = new FileCredentialStore(credentialsPath());
  const configRepo = new JsonConfigRepository(fs);
  const prompt = new ClackPrompt(opts.interactive);
  const logger = new ConsoleLogger(opts.debug);

  const providers = new ProviderRegistry(builtInProviders({ http, fs, git, proc }));
  const credentials = new CredentialResolver(store, prompt);
  const detect = new DetectProject(builtInDetectors(fs), configRepo);
  const generate = new GenerateArtifacts(builtInGenerators(), providers, fs, prompt, logger);
  const build = new BuildProject(proc, fs, logger);
  const listProviders = new ListProviders(providers, store, proc);
  const repoHost = new GitHubRepositoryHost(http, proc);
  const secrets = new SecretGuard(fs, prompt, logger);
  const productionEnv = new ProductionEnvironment(fs, prompt, logger, secrets);
  const repos = new RepositoryBootstrapper(git, repoHost, fs, credentials, prompt, logger, secrets);

  return {
    prompt,
    logger,
    providers,
    detect,
    generate,
    listProviders,
    init: new InitProject(detect, providers, generate, configRepo, prompt, logger),
    deploy: new DeployProject(detect, providers, generate, build, credentials, configRepo, git, repos, prompt, logger, new SystemBrowser(proc), secrets, productionEnv),
    login: new LoginProvider(providers, store, prompt, [repoHost]),
    logout: new LogoutProvider(providers, store, [repoHost]),
    doctor: new DoctorCheck(detect, listProviders, git, productionEnv),
    status: new GetDeploymentStatus(providers, credentials, configRepo),
  };
}

export type Container = ReturnType<typeof createContainer>;
