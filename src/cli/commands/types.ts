import type { Container } from '../container.js';

export interface CommandEnv {
  container(): Container;
  cwd(): string;
  debug(): boolean;
}
