import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createCliProgress } from '../../src/cli-progress.js';
import type { ProgressEvent } from '../../src/types.js';

interface CapturedStream extends Writable {
  isTTY?: boolean;
  buffer: string;
}

function makeStream(isTTY: boolean): CapturedStream {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  }) as CapturedStream;
  stream.isTTY = isTTY;
  Object.defineProperty(stream, 'buffer', {
    get: () => chunks.join(''),
  });
  return stream;
}

describe('cli-progress', () => {
  it('renders inline updates with carriage return when stream is a TTY', () => {
    const stream = makeStream(true);
    const progress = createCliProgress({ stream });

    const events: ProgressEvent[] = [
      { step: 'discovery', mode: 'flat', files: 3 },
      { step: 'plan', chunks: 2 },
      { step: 'write', index: 1, total: 2, filename: 'out-0001.pdf' },
      { step: 'write', index: 2, total: 2, filename: 'out-0002.pdf' },
      { step: 'done', outputs: ['out-0001.pdf', 'out-0002.pdf'] },
    ];
    for (const e of events) progress(e);

    expect(stream.buffer).toContain('\r\x1b[2K');
    expect(stream.buffer).toContain('[discovery] 3 file(s) — mode: flat');
    expect(stream.buffer).toContain('[write  2/2] out-0002.pdf');
    expect(stream.buffer.endsWith('\n')).toBe(true);
  });

  it('falls back to one line per event when stream is not a TTY', () => {
    const stream = makeStream(false);
    const progress = createCliProgress({ stream });

    progress({ step: 'discovery', mode: 'tree', files: 5 });
    progress({ step: 'stage', index: 1, total: 5, label: 'Vol 01/cap-01' });
    progress({ step: 'write', index: 1, total: 1, filename: 'x-0001.pdf' });
    progress({ step: 'done', outputs: ['x-0001.pdf'] });

    const lines = stream.buffer.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('[discovery] 5 file(s) — mode: tree');
    expect(lines[1]).toBe('[stage  1/5] Vol 01/cap-01');
    expect(lines[2]).toBe('[write  1/1] x-0001.pdf');
    expect(stream.buffer).not.toContain('\r');
  });

  it('truncates very long stage labels', () => {
    const stream = makeStream(true);
    const progress = createCliProgress({ stream });
    const longLabel = 'a'.repeat(200);

    progress({ step: 'stage', index: 1, total: 1, label: longLabel });

    expect(stream.buffer).toContain('…');
    expect(stream.buffer).not.toContain(longLabel);
  });

  it('inserts a newline when transitioning between phases (TTY)', () => {
    const stream = makeStream(true);
    const progress = createCliProgress({ stream });

    progress({ step: 'stage', index: 1, total: 2, label: 'a' });
    progress({ step: 'stage', index: 2, total: 2, label: 'b' });
    progress({ step: 'write', index: 1, total: 1, filename: 'f.pdf' });

    const newlines = (stream.buffer.match(/\n/g) ?? []).length;
    expect(newlines).toBe(1);
  });

  it('honours an explicit enabled override regardless of TTY', () => {
    const stream = makeStream(false);
    const progress = createCliProgress({ stream, enabled: true });
    progress({ step: 'plan', chunks: 4 });
    expect(stream.buffer).toContain('\r\x1b[2K');
  });
});
