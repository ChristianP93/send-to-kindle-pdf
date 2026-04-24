export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  readonly verbose?: boolean;
  readonly stream?: NodeJS.WritableStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const stream = options.stream ?? process.stderr;
  const verbose = options.verbose ?? false;

  const write = (level: LogLevel, message: string): void => {
    stream.write(`[${level}] ${message}\n`);
  };

  return {
    debug(message: string): void {
      if (verbose) write('debug', message);
    },
    info(message: string): void {
      write('info', message);
    },
    warn(message: string): void {
      write('warn', message);
    },
    error(message: string): void {
      write('error', message);
    },
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
