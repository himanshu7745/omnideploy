import * as p from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { checkCompatibility, describeProfile, IncompatibleProviderError, suggestAlternatives } from '../../domain/index.js';
import type { CommandEnv } from './types.js';

export function registerGenerate(program: Command, env: CommandEnv): void {
  program
    .command('generate')
    .alias('eject')
    .description('Only write the deployment files (Dockerfile, render.yaml, ...) — deploy them however you like')
    .argument('<providers...>', 'providers to generate files for')
    .option('-f, --force', 'overwrite existing files')
    .option('-y, --yes', 'write without asking')
    .option('--dry-run', 'list the files without writing them')
    .action(async (providerIds: string[], opts: { force?: boolean; yes?: boolean; dryRun?: boolean }) => {
      const c = env.container();
      p.intro(pc.inverse(' omnideploy generate '));
      const { profile, config } = await c.detect.execute(env.cwd());
      p.log.success(`Detected ${describeProfile(profile)}`);
      for (const id of providerIds) {
        const provider = c.providers.get(id);
        const compat = checkCompatibility(profile, provider.capabilities);
        if (!compat.ok) throw new IncompatibleProviderError(provider.displayName, compat.reason, suggestAlternatives(profile, c.providers.all(), id));
      }
      const { planned, written } = await c.generate.execute({ profile, config, providerIds, ...opts });
      const kept = planned.filter((a) => a.action === 'keep').map((a) => a.path);
      if (kept.length) p.log.info(`Kept existing: ${kept.join(', ')} (use --force to regenerate)`);
      p.outro(written.length ? `Wrote ${written.length} file(s).` : opts.dryRun ? 'Dry run — nothing written.' : 'Nothing to generate.');
    });
}
