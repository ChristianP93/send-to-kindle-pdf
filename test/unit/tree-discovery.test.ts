import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NoUnitsFoundError,
  TooManyFilesError,
  TreeDepthExceededError,
  discoverTree,
} from '../../src/core/tree-discovery.js';
import { silentLogger } from '../../src/logger.js';

const skipSymlink = platform() === 'win32';

describe('discoverTree', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'td-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function touch(rel: string): Promise<void> {
    const path = join(root, rel);
    const parent = path.substring(0, path.lastIndexOf('/'));
    if (parent && parent !== root) await mkdir(parent, { recursive: true });
    await writeFile(path, 'x');
  }

  it('returns flat mode when root has only PDFs at top level', async () => {
    await touch('a.pdf');
    await touch('b.pdf');
    const res = await discoverTree({
      inputDir: root,
      logger: silentLogger,
      outputDirName: 'output',
      mode: 'auto',
    });
    expect(res.mode).toBe('flat');
    expect(res.units).toHaveLength(0);
  });

  it('detects tree mode with JJK-like layout and orders volumes first', async () => {
    await touch('Volume 01/capitolo-01/1.jpg');
    await touch('Volume 01/capitolo-01/2.png');
    await touch('Volume 01/capitolo-02/1.jpg');
    await touch('Volume 02/capitolo-08/1.jpg');
    await touch('Capitolo 168/1.jpg');
    await touch('Capitolo 168.5/1.jpg');
    await touch('Capitolo 169/1.jpg');

    const res = await discoverTree({
      inputDir: root,
      logger: silentLogger,
      outputDirName: 'output',
      mode: 'auto',
    });

    expect(res.mode).toBe('tree');
    const labels = res.units.map((u) => u.label);
    expect(labels).toEqual(
      [
        'Capitolo 168/capitolo-01',
        'Capitolo 168/capitolo-02',
        'Capitolo 168/capitolo-08',
        'Capitolo 168',
        'Capitolo 168.5',
        'Capitolo 169',
      ].map((_, i) => labels[i]!),
    );

    expect(labels[0]).toMatch(/^Volume 01/);
    expect(labels[labels.length - 1]).toMatch(/^Capitolo 169/);

    const volumeLabels = labels.filter((l) => l.startsWith('Volume'));
    const chapterLabels = labels.filter((l) => l.startsWith('Capitolo'));
    const lastVolumeIdx = labels.lastIndexOf(volumeLabels[volumeLabels.length - 1]!);
    const firstChapterIdx = labels.indexOf(chapterLabels[0]!);
    expect(lastVolumeIdx).toBeLessThan(firstChapterIdx);

    expect(chapterLabels).toEqual(['Capitolo 168', 'Capitolo 168.5', 'Capitolo 169']);
  });

  it('places root-level PDFs after all subdirectory leaves', async () => {
    await touch('Volume 01/cap-01/1.jpg');
    await touch('extra.pdf');

    const res = await discoverTree({
      inputDir: root,
      logger: silentLogger,
      outputDirName: 'output',
      mode: 'auto',
    });

    expect(res.mode).toBe('tree');
    const labels = res.units.map((u) => u.label);
    expect(labels[0]).toBe('Volume 01/cap-01');
    expect(labels[labels.length - 1]).toBe('extra.pdf');
  });

  it('excludes the output directory from scanning', async () => {
    await touch('Cap 1/1.jpg');
    await touch('output/old-0001.pdf');

    const res = await discoverTree({
      inputDir: root,
      logger: silentLogger,
      outputDirName: 'output',
      mode: 'auto',
    });

    const paths = res.units.map((u) => u.label);
    expect(paths.some((p) => p.startsWith('output'))).toBe(false);
    expect(paths).toContain('Cap 1');
  });

  it('skips empty leaf folders with a warning', async () => {
    await touch('Cap 1/1.jpg');
    await mkdir(join(root, 'empty-leaf'));

    const res = await discoverTree({
      inputDir: root,
      logger: silentLogger,
      outputDirName: 'output',
      mode: 'auto',
    });

    expect(res.units.map((u) => u.label)).toEqual(['Cap 1']);
    expect(res.skipped.some((s) => s.name === 'empty-leaf')).toBe(true);
  });

  it('throws NoUnitsFoundError when tree has no usable leaves', async () => {
    await mkdir(join(root, 'empty-a'));
    await mkdir(join(root, 'empty-b'));
    await expect(
      discoverTree({
        inputDir: root,
        logger: silentLogger,
        outputDirName: 'output',
        mode: 'tree',
      }),
    ).rejects.toThrow(NoUnitsFoundError);
  });

  it('applies natural sort inside leaf for chapter pages', async () => {
    await touch('Cap 1/1.jpg');
    await touch('Cap 1/2.jpg');
    await touch('Cap 1/10.png');
    await touch('Cap 1/11.png');

    const res = await discoverTree({
      inputDir: root,
      logger: silentLogger,
      outputDirName: 'output',
      mode: 'auto',
    });

    const entries = res.units[0]!.entries;
    const names = entries.map((e) => e.path.split('/').pop());
    expect(names).toEqual(['1.jpg', '2.jpg', '10.png', '11.png']);
  });

  it('classifies leaves as image-folder / pdf-folder / mixed-folder', async () => {
    await touch('only-images/1.jpg');
    await touch('only-pdfs/a.pdf');
    await touch('mixed/1.jpg');
    await touch('mixed/a.pdf');

    const res = await discoverTree({
      inputDir: root,
      logger: silentLogger,
      outputDirName: 'output',
      mode: 'auto',
    });

    const byLabel = new Map(res.units.map((u) => [u.label, u]));
    expect(byLabel.get('only-images')!.kind).toBe('image-folder');
    expect(byLabel.get('only-pdfs')!.kind).toBe('pdf-folder');
    expect(byLabel.get('mixed')!.kind).toBe('mixed-folder');
  });

  it('warns when images/pdf live inside a non-leaf (parent of subdirs)', async () => {
    await touch('mix/child/1.jpg');
    await touch('mix/loose.pdf');

    const res = await discoverTree({
      inputDir: root,
      logger: silentLogger,
      outputDirName: 'output',
      mode: 'auto',
    });

    expect(res.skipped.some((s) => s.name.endsWith('loose.pdf'))).toBe(true);
  });

  it.skipIf(skipSymlink)('skips symlinked subdirectories with a warning', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'td-target-'));
    try {
      await writeFile(join(otherRoot, 'evil.pdf'), 'x');
      await touch('Cap 1/1.jpg');
      await symlink(otherRoot, join(root, 'linked-dir'));

      const res = await discoverTree({
        inputDir: root,
        logger: silentLogger,
        outputDirName: 'output',
        mode: 'auto',
      });

      const labels = res.units.map((u) => u.label);
      expect(labels).toEqual(['Cap 1']);
      expect(res.skipped.some((s) => s.name === 'linked-dir')).toBe(true);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(skipSymlink)('skips symlinked files inside leaves', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'td-target-'));
    try {
      await writeFile(join(otherRoot, 'leak.pdf'), 'x');
      await touch('Cap 1/real.pdf');
      await symlink(join(otherRoot, 'leak.pdf'), join(root, 'Cap 1', 'link.pdf'));

      const res = await discoverTree({
        inputDir: root,
        logger: silentLogger,
        outputDirName: 'output',
        mode: 'auto',
      });

      const unit = res.units.find((u) => u.label === 'Cap 1');
      expect(unit?.entries.map((e) => e.path.split('/').pop())).toEqual(['real.pdf']);
      expect(res.skipped.some((s) => s.name === 'Cap 1/link.pdf')).toBe(true);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('throws TreeDepthExceededError on excessive nesting', async () => {
    let p = '';
    for (let i = 0; i < 35; i += 1) {
      p = join(p, `d${i}`);
    }
    await touch(`${p}/leaf.pdf`);

    await expect(
      discoverTree({
        inputDir: root,
        logger: silentLogger,
        outputDirName: 'output',
        mode: 'tree',
      }),
    ).rejects.toThrow(TreeDepthExceededError);
  });

  it('exposes TooManyFilesError with the expected name', () => {
    const err = new TooManyFilesError('/tmp', 50_000);
    expect(err.name).toBe('TooManyFilesError');
    expect(err.message).toContain('50000');
  });
});
