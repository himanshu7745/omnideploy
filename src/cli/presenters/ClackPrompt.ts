import * as p from '@clack/prompts';
import { UserCancelledError, type Choice, type PromptPort, type Spinner } from '../../domain/index.js';

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new UserCancelledError();
  return value as Exclude<T, symbol>;
}

export class ClackPrompt implements PromptPort {
  constructor(readonly interactive: boolean) {}

  async confirm(message: string, initial = true): Promise<boolean> {
    return unwrap(await p.confirm({ message, initialValue: initial }));
  }

  async select<T extends string>(message: string, choices: Choice<T>[]): Promise<T> {
    return unwrap(await p.select<T>({ message, options: choices as never }));
  }

  async multiselect<T extends string>(message: string, choices: Choice<T>[], initial: T[] = []): Promise<T[]> {
    return unwrap(await p.multiselect<T>({ message, options: choices as never, initialValues: initial, required: true }));
  }

  async text(message: string, opts: { placeholder?: string; initial?: string } = {}): Promise<string> {
    return unwrap(await p.text({ message, placeholder: opts.placeholder, initialValue: opts.initial }));
  }

  async password(message: string): Promise<string> {
    return unwrap(await p.password({ message }));
  }

  note(body: string, title?: string): void {
    p.note(body, title);
  }

  spinner(): Spinner {
    if (!this.interactive) {
      // Plain line output for CI logs.
      return {
        start: (m) => p.log.step(m),
        message: () => {},
        stop: (m, ok = true) => (ok ? p.log.success(m) : p.log.error(m)),
      };
    }
    const s = p.spinner();
    return {
      start: (m) => s.start(m),
      message: (m) => s.message(m),
      stop: (m, ok = true) => (ok ? s.stop(m) : s.error(m)),
    };
  }
}
