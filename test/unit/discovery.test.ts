import { mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InputDirectoryError,
  NoPdfFoundError,
  TooManyFlatFilesError,
  discoverPdfFiles,
} from '../../src/core/discovery.js';
import { silentLogger } from '../../src/logger.js';

const skipSymlink = platform() === 'win32';

describe('discoverPdfFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'discovery-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const touch = async (name: string): Promise<void> => {
    await writeFile(join(dir, name), 'x');
  };

  it('lists PDFs and applies natural sort', async () => {
    await touch('cap-10.pdf');
    await touch('cap-2.pdf');
    await touch('cap-102.pdf');
    await touch('cap-1.pdf');

    const { files } = await discoverPdfFiles({ inputDir: dir, logger: silentLogger });
    expect(files.map((f) => f.name)).toEqual([
      'cap-1.pdf',
      'cap-2.pdf',
      'cap-10.pdf',
      'cap-102.pdf',
    ]);
  });

  it('is case-insensitive on the .pdf extension', async () => {
    await touch('a.PDF');
    await touch('b.Pdf');
    await touch('c.pdf');
    const { files } = await discoverPdfFiles({ inputDir: dir, logger: silentLogger });
    expect(files.map((f) => f.name).sort()).toEqual(['a.PDF', 'b.Pdf', 'c.pdf']);
  });

  it('skips non-PDF files and reports them', async () => {
    await touch('a.pdf');
    await touch('cover.jpg');
    await touch('notes.txt');

    const { files, skipped } = await discoverPdfFiles({ inputDir: dir, logger: silentLogger });
    expect(files).toHaveLength(1);
    expect(skipped.map((s) => s.name).sort()).toEqual(['cover.jpg', 'notes.txt']);
  });

  it('throws NoPdfFoundError when directory has no PDFs', async () => {
    await touch('cover.jpg');
    await expect(discoverPdfFiles({ inputDir: dir, logger: silentLogger })).rejects.toThrow(
      NoPdfFoundError,
    );
  });

  it('throws InputDirectoryError when directory does not exist', async () => {
    await expect(
      discoverPdfFiles({ inputDir: join(dir, 'does-not-exist'), logger: silentLogger }),
    ).rejects.toThrow(InputDirectoryError);
  });

  it.skipIf(skipSymlink)('skips symlinked PDFs and reports them', async () => {
    const realDir = await mkdtemp(join(tmpdir(), 'discovery-target-'));
    try {
      await writeFile(join(realDir, 'real.pdf'), 'x');
      await touch('legit.pdf');
      await symlink(join(realDir, 'real.pdf'), join(dir, 'evil.pdf'));

      const { files, skipped } = await discoverPdfFiles({ inputDir: dir, logger: silentLogger });
      expect(files.map((f) => f.name)).toEqual(['legit.pdf']);
      expect(skipped.find((s) => s.name === 'evil.pdf')?.reason).toBe('symbolic link');
    } finally {
      await rm(realDir, { recursive: true, force: true });
    }
  });

  it('exposes TooManyFlatFilesError with the expected name', () => {
    const err = new TooManyFlatFilesError('/tmp', 50_000);
    expect(err.name).toBe('TooManyFlatFilesError');
    expect(err.message).toContain('50000');
  });
});
