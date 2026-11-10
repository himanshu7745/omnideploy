import * as p from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CommandEnv } from './types.js';

export function registerStatus(program: Command, env: CommandEnv): void {
  program
    .command('status')
    .description('Show the latest (or a specific) deployment for a provider')
    .argument('<provider>')
    .argument('[deploymentId]')
    .action(async (provider: string, id?: string) => {
      const c = env.container();
      const s = await c.status.execute(env.cwd(), provider, id);
      const color = s.state === 'ready' ? pc.green : s.state === 'error' ? pc.red : pc.yellow;
      p.note(
        [`State:   ${color(s.state)}`, `ID:      ${s.id}`, s.url && `URL:     ${pc.cyan(s.url)}`, s.createdAt && `Created: ${s.createdAt}`, s.message && `Info:    ${s.message}`]
          .filter(Boolean)
          .join('\n'),
        c.providers.get(provider).displayName,
      );
    });
}
