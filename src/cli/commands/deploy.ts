import * as p from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { describeError, table } from '../presenters/format.js';
import type { CommandEnv } from './types.js';

interface DeployOpts {
  preview?: boolean;
  build: boolean;
  dir?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerDeploy(program: Command, env: CommandEnv): void {
  program
    .command('deploy')
    .description('Deploy to one or more providers (default: those in omnideploy.json)')
    .argument('[providers...]', 'e.g. vercel netlify github-pages railway render')
    .option('--preview', 'create a preview/draft deployment instead of production')
    .option('--no-build', 'skip the local build step')
    .option('-d, --dir <path>', 'deploy this directory as a static site')
    .option('--dry-run', 'show what would happen without deploying')
    .option('-y, --yes', 'answer yes to every prompt (CI mode)')
    .option('-f, --force', 'regenerate deployment files even if they exist')
    .action(async (providers: string[], opts: DeployOpts) => {
      const c = env.container();
      p.intro(pc.inverse(' omnideploy deploy '));
      const report = await c.deploy.execute({
        rootDir: env.cwd(),
        providerIds: providers,
        production: !opts.preview,
        skipBuild: !opts.build,
        dir: opts.dir,
        dryRun: opts.dryRun,
        yes: opts.yes,
        force: opts.force,
      });
      if (report.dryRun) {
        p.outro('Dry run complete — nothing was deployed.');
        return;
      }

      const rows = report.outcomes.map((o) => [
        o.displayName,
        o.ok ? (o.deployment?.state === 'ready' ? pc.green('✔ live') : pc.yellow('… building')) : pc.red('✖ failed'),
        o.ok ? pc.cyan(o.deployment?.url ?? '(no public URL)') : '',
      ]);
      p.note(table(['Provider', 'Status', 'URL'], rows), 'Deployments');
      for (const o of report.outcomes.filter((o) => !o.ok)) p.log.error(`${o.displayName}: ${describeError(o.error)}`);

      const failed = report.outcomes.filter((o) => !o.ok).length;
      if (failed > 0) {
        process.exitCode = 1;
        p.outro(pc.red(`${failed} of ${report.outcomes.length} deployment(s) failed.`));
      } else {
        p.outro(pc.green('All deployments finished.'));
      }
    });
}
