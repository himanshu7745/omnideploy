import * as p from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CommandEnv } from './types.js';

const ICON = { ok: pc.green('✔'), warn: pc.yellow('▲'), fail: pc.red('✖') };

export function registerDoctor(program: Command, env: CommandEnv): void {
  program
    .command('doctor')
    .description('Check that everything needed to deploy this project is in place')
    .action(async () => {
      const c = env.container();
      p.intro(pc.inverse(' omnideploy doctor '));
      const checks = await c.doctor.execute(env.cwd(), { nodeVersion: process.version });
      for (const ch of checks) {
        p.log.message(`${ICON[ch.status]} ${pc.bold(ch.name)}: ${ch.detail}${ch.fix ? ch.fix.split('\n').map((f) => `\n  ${pc.cyan('Fix:')} ${f}`).join('') : ''}`);
      }
      const failed = checks.filter((ch) => ch.status === 'fail').length;
      const warned = checks.filter((ch) => ch.status === 'warn').length;
      if (failed) process.exitCode = 1;
      p.outro(
        failed ? pc.red(`${failed} problem(s) to fix before deploying.`)
        : warned ? pc.yellow(`Ready, with ${warned} warning(s).`)
        : pc.green('Everything looks good!'),
      );
    });
}
