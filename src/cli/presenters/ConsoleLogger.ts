import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { LoggerPort } from '../../domain/index.js';

export class ConsoleLogger implements LoggerPort {
  constructor(private readonly debugEnabled = false) {}

  info(message: string): void {
    p.log.info(message);
  }
  step(message: string): void {
    p.log.step(message);
  }
  success(message: string): void {
    p.log.success(message);
  }
  warn(message: string): void {
    p.log.warn(message);
  }
  error(message: string): void {
    p.log.error(message);
  }
  debug(message: string): void {
    if (this.debugEnabled) p.log.message(pc.dim(message));
  }
}
