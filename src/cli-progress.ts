import type { ProgressEvent } from './types.js';

export interface CliProgressOptions {
  readonly stream?: NodeJS.WritableStream & { isTTY?: boolean };
  readonly enabled?: boolean;
}

type Phase = 'discovery' | 'stage' | 'normalize' | 'plan' | 'write' | 'done';

const CLEAR_LINE = '\r\x1b[2K';

/**
 * Build an `onProgress` handler that renders a single-line progress bar.
 *
 * Inline (carriage-return) mode is enabled only when the target stream is a
 * TTY: piped/redirected stderr would accumulate `\r\x1b[2K` escape sequences
 * as garbage. Non-TTY callers get one line per event instead.
 *
 * Note: the renderer writes to the same stream as `Logger`. The CLI disables
 * progress under `--verbose` because logger lines would interleave with the
 * inline updates and clobber them mid-write.
 */
export function createCliProgress(
  options: CliProgressOptions = {},
): (event: ProgressEvent) => void {
  const stream = options.stream ?? process.stderr;
  const ttyEnabled = options.enabled ?? Boolean(stream.isTTY);

  let currentPhase: Phase | null = null;
  let inlineActive = false;

  const writeInline = (text: string): void => {
    stream.write(`${CLEAR_LINE}${text}`);
    inlineActive = true;
  };

  const flushLine = (): void => {
    if (inlineActive) {
      stream.write('\n');
      inlineActive = false;
    }
  };

  const writeFallback = (text: string): void => {
    stream.write(`${text}\n`);
  };

  const transition = (next: Phase): void => {
    if (ttyEnabled && currentPhase !== null && currentPhase !== next) {
      flushLine();
    }
    currentPhase = next;
  };

  const truncate = (s: string, max: number): string =>
    s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

  return (event: ProgressEvent): void => {
    transition(event.step);

    switch (event.step) {
      case 'discovery': {
        const line = `[discovery] ${event.files} file(s) — mode: ${event.mode}`;
        if (ttyEnabled) writeInline(line);
        else writeFallback(line);
        return;
      }
      case 'stage': {
        const label = truncate(event.label, 60);
        const line = `[stage  ${event.index}/${event.total}] ${label}`;
        if (ttyEnabled) writeInline(line);
        else writeFallback(line);
        return;
      }
      case 'normalize': {
        const name = truncate(event.filename, 60);
        const line = `[normalize ${event.index}/${event.total}] ${name}`;
        if (ttyEnabled) writeInline(line);
        else writeFallback(line);
        return;
      }
      case 'plan': {
        const line = `[plan]  ${event.chunks} chunk(s)`;
        if (ttyEnabled) writeInline(line);
        else writeFallback(line);
        return;
      }
      case 'write': {
        const line = `[write  ${event.index}/${event.total}] ${event.filename}`;
        if (ttyEnabled) writeInline(line);
        else writeFallback(line);
        return;
      }
      case 'done': {
        if (ttyEnabled) flushLine();
        return;
      }
    }
  };
}
