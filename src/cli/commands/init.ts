import * as p from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CommandEnv } from './types.js';

export function registerInit(program: Command, env: CommandEnv): void {
  program
    .command('init')
    .description('Detect the project, pick providers, and generate deployment files + omnideploy.json')
    .option('-p, --providers <ids>', 'comma-separated providers (skips the prompt)')
    .option('-y, --yes', 'accept defaults and write files without asking')
    .option('-f, --force', 'overwrite existing deployment files')
    .action(async (opts: { providers?: string; yes?: boolean; force?: boolean }) => {
      const c = env.container();
      p.intro(pc.inverse(' omnideploy init '));
      const result = await c.init.execute({
        rootDir: env.cwd(),
        providerIds: opts.providers?.split(',').map((s) => s.trim()).filter(Boolean),
        yes: opts.yes,
        force: opts.force,
      });
      p.outro(`Ready! Deploy with ${pc.cyan(`omnideploy deploy${result.providerIds.length === 1 ? ` ${result.providerIds[0]}` : ''}`)}`);
    });
}
