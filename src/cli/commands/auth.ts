import * as p from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CommandEnv } from './types.js';

export function registerAuth(program: Command, env: CommandEnv): void {
  program
    .command('login')
    .description('Save an API token for a provider')
    .argument('<provider>')
    .option('-t, --token <token>', 'token value (otherwise prompted; prefer the env var in CI)')
    .action(async (provider: string, opts: { token?: string }) => {
      const c = env.container();
      await c.login.execute(provider, opts.token);
      p.log.success(`Logged in to ${c.providers.get(provider).displayName}.`);
    });

  program
    .command('logout')
    .description('Remove a saved provider token')
    .argument('<provider>')
    .action(async (provider: string) => {
      const c = env.container();
      const removed = await c.logout.execute(provider);
      const name = c.providers.get(provider).displayName;
      if (removed) p.log.success(`Logged out of ${name}.`);
      else p.log.info(`No saved token for ${name}.`);
      p.log.message(pc.dim(`(Tokens set via ${c.providers.get(provider).capabilities.auth.envVar} are not affected.)`));
    });
}
