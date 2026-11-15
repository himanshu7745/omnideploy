import {
  describeProfile,
  DomainError,
  type GitPort,
  type ProjectProfile,
} from '../../domain/index.js';
import type { DetectProject } from './DetectProject.js';
import type { ListProviders } from './ListProviders.js';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export class DoctorCheck {
  constructor(
    private readonly detect: DetectProject,
    private readonly listProviders: ListProviders,
    private readonly git: GitPort,
  ) {}

  async execute(rootDir: string, runtime: { nodeVersion: string }): Promise<Check[]> {
    const checks: Check[] = [];
    const major = Number(runtime.nodeVersion.replace(/^v/, '').split('.')[0]);
    checks.push(
      major >= 20
        ? { name: 'Node.js', status: 'ok', detail: runtime.nodeVersion }
        : { name: 'Node.js', status: 'fail', detail: runtime.nodeVersion, fix: 'Install Node.js 20 or newer.' },
    );

    let profile: ProjectProfile | undefined;
    let configured: string[] = [];
    try {
      const r = await this.detect.execute(rootDir);
      profile = r.profile;
      configured = Object.keys(r.config?.providers ?? {});
      checks.push({ name: 'Project', status: 'ok', detail: describeProfile(r.profile) });
      checks.push(
        r.config
          ? { name: 'Config', status: 'ok', detail: `omnideploy.json (${configured.join(', ') || 'no providers'})` }
          : { name: 'Config', status: 'warn', detail: 'no omnideploy.json', fix: 'Run `omnideploy init`.' },
      );
    } catch (e) {
      checks.push({
        name: 'Project',
        status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
        fix: e instanceof DomainError ? e.hint : undefined,
      });
    }

    if (await this.git.isRepo(rootDir)) {
      const remote = await this.git.remote(rootDir);
      checks.push(
        remote
          ? { name: 'Git remote', status: 'ok', detail: remote.url }
          : {
              name: 'Git remote',
              status: 'warn',
              detail: 'none',
              fix: 'Render: on the first deploy omnideploy offers to create a private GitHub repo.\nGitHub Pages: add a GitHub remote (git remote add origin <url>).',
            },
      );
    } else {
      checks.push({
        name: 'Git',
        status: 'warn',
        detail: 'not a git repository',
        fix: 'Render: on the first deploy omnideploy offers to set up git and a private GitHub repo.\nGitHub Pages: git init and add a GitHub remote.',
      });
    }

    for (const row of await this.listProviders.execute(profile)) {
      const relevant = configured.length === 0 || configured.includes(row.id);
      if (!relevant) continue;
      const problems: string[] = [];
      const fixes: string[] = [];
      if (!row.auth) {
        problems.push('not logged in');
        fixes.push(`omnideploy login ${row.id}`);
      }
      if (row.cli && !row.cli.installed) {
        problems.push(`${row.cli.bin} CLI missing`);
        fixes.push(row.cli.install);
      }
      if (row.compatibility && !row.compatibility.ok) problems.push(row.compatibility.reason ?? 'incompatible');
      checks.push({
        name: row.displayName,
        status: problems.length === 0 ? 'ok' : configured.includes(row.id) ? 'fail' : 'warn',
        detail: problems.length === 0 ? `ready (token from ${row.auth})` : problems.join(', '),
        fix: fixes.join('\n') || undefined,
      });
    }
    return checks;
  }
}
