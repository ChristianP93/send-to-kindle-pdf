import { describe, expect, it } from 'vitest';

import { NoReadablePdfsError } from '../../src/index.js';

describe('NoReadablePdfsError', () => {
  it('uses tree-mode wording when mode is tree', () => {
    const err = new NoReadablePdfsError('tree', [{ name: 'cap-01', reason: 'corrupt image' }]);
    expect(err.name).toBe('NoReadablePdfsError');
    expect(err.message).toContain('No leaf unit produced a readable PDF.');
    expect(err.message).toContain('cap-01 (corrupt image)');
  });

  it('uses flat-mode wording when mode is flat', () => {
    const err = new NoReadablePdfsError('flat', [
      { name: 'a.pdf', reason: 'invalid header' },
      { name: 'b.pdf', reason: 'empty PDF' },
    ]);
    expect(err.message).toContain('All discovered PDFs failed to load.');
    expect(err.message).toContain('Skipped 2');
    expect(err.message).toContain('a.pdf (invalid header)');
    expect(err.message).toContain('b.pdf (empty PDF)');
  });

  it('omits skipped detail when list is empty', () => {
    const err = new NoReadablePdfsError('flat', []);
    expect(err.message).toBe('All discovered PDFs failed to load.');
  });

  it('exposes mode and skipped as readonly fields', () => {
    const skipped = [{ name: 'x', reason: 'y' }];
    const err = new NoReadablePdfsError('tree', skipped);
    expect(err.mode).toBe('tree');
    expect(err.skipped).toEqual(skipped);
  });
});
