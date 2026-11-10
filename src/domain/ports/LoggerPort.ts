export interface LoggerPort {
  info(message: string): void;
  step(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}
