import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createLogger, silentLogger } from '../../src/logger.js';

function captureStream(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
}

describe('createLogger', () => {
  it('writes info/warn/error messages to the provided stream', () => {
    const { stream, read } = captureStream();
    const logger = createLogger({ stream });
    logger.info('hello');
    logger.warn('caution');
    logger.error('boom');
    const out = read();
    expect(out).toContain('[info] hello');
    expect(out).toContain('[warn] caution');
    expect(out).toContain('[error] boom');
  });

  it('omits debug messages unless verbose is true', () => {
    const a = captureStream();
    const silent = createLogger({ stream: a.stream });
    silent.debug('nope');
    expect(a.read()).toBe('');

    const b = captureStream();
    const verbose = createLogger({ stream: b.stream, verbose: true });
    verbose.debug('yes');
    expect(b.read()).toContain('[debug] yes');
  });
});

describe('silentLogger', () => {
  it('is a no-op at every level', () => {
    expect(() => {
      silentLogger.debug('x');
      silentLogger.info('x');
      silentLogger.warn('x');
      silentLogger.error('x');
    }).not.toThrow();
  });
});
