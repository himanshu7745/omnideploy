export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Stream output to the user's terminal instead of capturing it. */
  inherit?: boolean;
  /** Text piped into stdin. */
  input?: string;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunnerPort {
  /** Runs a binary with args. Never throws on non-zero exit; inspect exitCode. */
  run(bin: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  /** Runs a full shell command line (used for user-provided build commands). */
  shell(command: string, opts?: RunOptions): Promise<RunResult>;
  /** True if `bin` is on PATH. */
  has(bin: string): Promise<boolean>;
}
