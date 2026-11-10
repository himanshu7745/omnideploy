import * as p from '@clack/prompts';
import pc from 'picocolors';
import { DomainError, UserCancelledError } from '../../domain/index.js';

/** Renders rows as an aligned plain-text table. */
export function table(headers: string[], rows: string[][]): string {
  // eslint-disable-next-line no-control-regex
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const widths = headers.map((h, i) => Math.max(visible(h), ...rows.map((r) => visible(r[i] ?? ''))));
  const line = (cells: string[]) => cells.map((c, i) => c + ' '.repeat(widths[i]! - visible(c))).join('  ').trimEnd();
  return [pc.bold(line(headers)), ...rows.map(line)].join('\n');
}

/** One-line cause plus a "Try:" hint. Stack traces only with --debug. */
export function presentError(error: unknown, debug: boolean): number {
  if (error instanceof UserCancelledError) {
    p.cancel('Cancelled.');
    return 130;
  }
  if (error instanceof DomainError) {
    p.log.error(error.message);
    if (error.hint) p.log.message(`${pc.cyan('Try:')} ${error.hint}`);
    if (debug && error.stack) p.log.message(pc.dim(error.stack));
    return 1;
  }
  p.log.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  if (debug && error instanceof Error && error.stack) p.log.message(pc.dim(error.stack));
  else p.log.message(pc.dim('Re-run with --debug for details.'));
  return 1;
}

export function describeError(error: unknown): string {
  if (error instanceof DomainError) return error.hint ? `${error.message}\n  ${pc.cyan('Try:')} ${error.hint}` : error.message;
  return error instanceof Error ? error.message : String(error);
}
