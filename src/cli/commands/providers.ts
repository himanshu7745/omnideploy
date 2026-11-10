import * as p from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { ProjectProfile } from '../../domain/index.js';
import { table } from '../presenters/format.js';
import type { CommandEnv } from './types.js';

export function registerProviders(program: Command, env: CommandEnv): void {
  program
    .command('providers')
    .alias('ls')
    .description('List providers, login state, required tools and compatibility with this project')
    .action(async () => {
      const c = env.container();
      let profile: ProjectProfile | undefined;
      try {
        profile = (await c.detect.execute(env.cwd())).profile;
      } catch {
        /* not inside a project — show the list without compatibility */
      }
      const rows = await c.listProviders.execute(profile);
      p.log.message(
        table(
          ['Provider', 'Id', 'Hosts', 'Auth', 'CLI', ...(profile ? ['Fits project'] : [])],
          rows.map((r) => [
            r.displayName,
            pc.dim(r.id),
            r.hosts,
            r.auth ? pc.green(`✔ ${r.auth}`) : pc.yellow('login needed'),
            r.cli ? (r.cli.installed ? pc.green(`✔ ${r.cli.bin}`) : pc.red(`✖ ${r.cli.bin}`)) : pc.dim('—'),
            ...(r.compatibility ? [r.compatibility.ok ? pc.green('✔') : pc.dim(`✖ ${r.compatibility.reason}`)] : []),
          ]),
        ),
      );
      if (rows.some((r) => !r.auth)) p.log.message(pc.dim('Log in with `omnideploy login <id>` or set the provider env var.'));
    });
}
