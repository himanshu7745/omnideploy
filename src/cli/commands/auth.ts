import * as p from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CommandEnv } from './types.js';

export function registerAuth(program: Command, env: CommandEnv): void {
  program
    .command('login')
    .description('Save an API token for a provider (or `github`, used to create repositories)')
    .argument('<provider>')
    .option('-t, --token <token>', 'token value (otherwise prompted; prefer the env var in CI)')
    .action(async (provider: string, opts: { token?: string }) => {
      const c = env.container();
      const s = await c.login.execute(provider, opts.token);
      p.log.success(`Logged in to ${s.displayName}.`);
    });

  program
    .command('logout')
    .description('Remove a saved provider token (or `github`)')
    .argument('<provider>')
    .action(async (provider: string) => {
      const c = env.container();
      const { subject, removed } = await c.logout.execute(provider);
      if (removed) p.log.success(`Logged out of ${subject.displayName}.`);
      else p.log.info(`No saved token for ${subject.displayName}.`);
      p.log.message(pc.dim(`(Tokens set via ${subject.auth.envVar} are not affected.)`));
    });
}
