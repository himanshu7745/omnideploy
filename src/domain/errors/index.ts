/**
 * Base class for expected, user-facing failures. The CLI renders `message` plus `hint`
 * and only shows stack traces with --debug.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly code: string = 'DOMAIN_ERROR',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedProjectError extends DomainError {
  constructor(rootDir: string) {
    super(
      `Could not detect a supported project in ${rootDir}.`,
      'Add a Dockerfile, or set build/app settings in omnideploy.json.',
      'UNSUPPORTED_PROJECT',
    );
  }
}

export class IncompatibleProviderError extends DomainError {
  constructor(provider: string, reason: string, suggestion?: string) {
    super(`${provider}: ${reason}`, suggestion, 'INCOMPATIBLE_PROVIDER');
  }
}

export class UnknownProviderError extends DomainError {
  constructor(id: string, known: readonly string[]) {
    super(`Unknown provider "${id}".`, `Available providers: ${known.join(', ')}`, 'UNKNOWN_PROVIDER');
  }
}

export class MissingCredentialError extends DomainError {
  constructor(provider: string, envVar: string) {
    super(
      `No credentials found for ${provider}.`,
      `Run \`omnideploy login ${provider}\` or set ${envVar}.`,
      'MISSING_CREDENTIAL',
    );
  }
}

export class MissingToolError extends DomainError {
  constructor(bin: string, install: string) {
    super(`Required tool "${bin}" is not installed.`, `Install it with: ${install}`, 'MISSING_TOOL');
  }
}

export class ConfigError extends DomainError {
  constructor(message: string, hint?: string) {
    super(message, hint, 'CONFIG_ERROR');
  }
}

export class BuildError extends DomainError {
  constructor(command: string, output?: string) {
    super(
      `Build failed: \`${command}\``,
      output ? `Last output:\n${output}` : 'Fix the build locally, or override it with build.command in omnideploy.json.',
      'BUILD_FAILED',
    );
  }
}

export class ProviderApiError extends DomainError {
  constructor(
    provider: string,
    message: string,
    readonly status?: number,
    hint?: string,
  ) {
    super(`${provider} API error${status ? ` (${status})` : ''}: ${message}`, hint, 'PROVIDER_API_ERROR');
  }
}

export class DeploymentFailedError extends DomainError {
  constructor(provider: string, detail: string, hint?: string) {
    super(`${provider} deployment failed: ${detail}`, hint, 'DEPLOYMENT_FAILED');
  }
}

export class GitError extends DomainError {
  constructor(message: string, hint?: string) {
    super(message, hint, 'GIT_ERROR');
  }
}

export class UserCancelledError extends DomainError {
  constructor() {
    super('Operation cancelled.', undefined, 'CANCELLED');
  }
}

/** The provider cannot read the project's git repository; `grantUrl` is where the user can grant access. */
export class RepoAccessError extends DomainError {
  constructor(
    readonly provider: string,
    readonly repo: string,
    readonly grantUrl: string,
    hint: string,
  ) {
    super(`${provider} cannot access ${repo}.`, hint, 'REPO_ACCESS');
  }
}
