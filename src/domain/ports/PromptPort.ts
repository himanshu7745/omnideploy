export interface Choice<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Spinner {
  start(message: string): void;
  message(message: string): void;
  stop(message: string, ok?: boolean): void;
}

/** Interactive input. Implementations must throw UserCancelledError on Ctrl-C. */
export interface PromptPort {
  readonly interactive: boolean;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  select<T extends string>(message: string, choices: Choice<T>[]): Promise<T>;
  multiselect<T extends string>(message: string, choices: Choice<T>[], initial?: T[]): Promise<T[]>;
  text(message: string, opts?: { placeholder?: string; initial?: string }): Promise<string>;
  password(message: string): Promise<string>;
  note(body: string, title?: string): void;
  spinner(): Spinner;
}
