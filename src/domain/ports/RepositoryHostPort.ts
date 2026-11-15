export interface CreatedRepository {
  id: number;
  owner: string;
  name: string;
  /** HTTPS clone URL (no credentials). */
  cloneUrl: string;
  webUrl: string;
}

/**
 * `already`: the app can see every repository. `unavailable`: the app isn't installed, or the token may not change it.
 * `unknown-installation`: this token can't look the installation up (personal tokens can't).
 */
export type AppAccessResult = 'granted' | 'already' | 'unavailable' | 'unknown-installation';

/** A git hosting service (e.g. GitHub) that omnideploy can create repositories on. */
export interface RepositoryHostPort {
  /** Credential store key. */
  readonly id: string;
  readonly displayName: string;
  readonly auth: { envVar: string; tokenUrl: string };
  /** A token from an existing local login (e.g. `gh auth token`), if there is one. */
  detectToken(): Promise<string | null>;
  createRepository(token: string, opts: { name: string; private: boolean }): Promise<CreatedRepository>;
  /** Lets an installed app (e.g. Render's GitHub app) read `repo`, when the token is allowed to. */
  grantAppAccess(token: string, repo: CreatedRepository, appSlug: string): Promise<AppAccessResult>;
}
