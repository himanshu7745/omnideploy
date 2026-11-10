import { execa } from 'execa';
import type { ProcessRunnerPort, RunOptions, RunResult } from '../../domain/index.js';

export class ExecaProcessRunner implements ProcessRunnerPort {
  async run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    try {
      const r = await execa(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        input: opts.input,
        reject: false,
        stdio: opts.inherit ? 'inherit' : 'pipe',
      });
      return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    } catch (e) {
      return { exitCode: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
    }
  }

  async shell(command: string, opts: RunOptions = {}): Promise<RunResult> {
    try {
      const r = await execa(command, {
        shell: true,
        cwd: opts.cwd,
        env: opts.env,
        input: opts.input,
        reject: false,
        stdio: opts.inherit ? 'inherit' : 'pipe',
      });
      return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    } catch (e) {
      return { exitCode: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
    }
  }

  async has(bin: string): Promise<boolean> {
    const probe = process.platform === 'win32' ? await this.run('where', [bin]) : await this.run('which', [bin]);
    return probe.exitCode === 0;
  }
}
