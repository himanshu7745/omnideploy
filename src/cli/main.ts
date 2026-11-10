import { resolve } from 'node:path';
import { Command } from 'commander';
import { registerAuth } from './commands/auth.js';
import { registerDeploy } from './commands/deploy.js';
import { registerDoctor } from './commands/doctor.js';
import { registerGenerate } from './commands/generate.js';
import { registerInit } from './commands/init.js';
import { registerProviders } from './commands/providers.js';
import { registerStatus } from './commands/status.js';
import type { CommandEnv } from './commands/types.js';
import { createContainer, type Container } from './container.js';
import { presentError } from './presenters/format.js';

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

const program = new Command()
  .name('omnideploy')
  .description('Detect, containerize and deploy any project to Vercel, Netlify, GitHub Pages, Railway, Render — with one CLI.')
  .version(VERSION)
  .option('-C, --cwd <dir>', 'project directory', process.cwd())
  .option('--debug', 'show stack traces and debug output')
  .option('--no-interactive', 'never prompt (also implied by CI=true or a non-TTY stdin)')
  .showHelpAfterError();

let container: Container | undefined;
const globals = () => program.opts<{ cwd: string; debug?: boolean; interactive: boolean }>();
const env: CommandEnv = {
  cwd: () => resolve(globals().cwd),
  debug: () => Boolean(globals().debug),
  container: () =>
    (container ??= createContainer({
      debug: Boolean(globals().debug),
      interactive: globals().interactive && Boolean(process.stdin.isTTY) && !process.env.CI,
      version: VERSION,
    })),
};

for (const register of [registerInit, registerDeploy, registerGenerate, registerAuth, registerProviders, registerDoctor, registerStatus]) {
  register(program, env);
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.exitCode = presentError(error, env.debug());
}
