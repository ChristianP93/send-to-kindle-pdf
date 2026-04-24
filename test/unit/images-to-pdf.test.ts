import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { buildPdfForLeaf } from '../../src/core/images-to-pdf.js';
import { silentLogger } from '../../src/logger.js';
import { makeRandomGrayscalePng, minimalJpeg } from '../helpers/image-encoders.js';

describe('buildPdfForLeaf', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'itp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, bytes: Uint8Array): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  }

  it('creates a PDF with one page per PNG image, page size = image size', async () => {
    const png32 = makeRandomGrayscalePng(32, 48);
    const png64 = makeRandomGrayscalePng(64, 64);
    const p1 = await write('1.png', png32);
    const p2 = await write('2.png', png64);

    const result = await buildPdfForLeaf(
      {
        leafPath: dir,
        entries: [
          { path: p1, kind: 'image' },
          { path: p2, kind: 'image' },
        ],
      },
      silentLogger,
    );

    expect(result.pageCount).toBe(2);
    expect(result.skipped).toHaveLength(0);

    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(2);

    const page1 = doc.getPage(0);
    expect(page1.getWidth()).toBe(32);
    expect(page1.getHeight()).toBe(48);

    const page2 = doc.getPage(1);
    expect(page2.getWidth()).toBe(64);
    expect(page2.getHeight()).toBe(64);
  });

  it('embeds JPEG images', async () => {
    const jpg = minimalJpeg();
    const p = await write('a.jpg', jpg);
    const result = await buildPdfForLeaf(
      { leafPath: dir, entries: [{ path: p, kind: 'image' }] },
      silentLogger,
    );
    expect(result.pageCount).toBe(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('appends pages from embedded PDFs in the order provided', async () => {
    const src = await PDFDocument.create();
    src.addPage([100, 100]);
    src.addPage([200, 200]);
    const srcBytes = await src.save();
    const pdfPath = await write('embed.pdf', srcBytes);

    const png = makeRandomGrayscalePng(16, 16);
    const pngPath = await write('1.png', png);

    const result = await buildPdfForLeaf(
      {
        leafPath: dir,
        entries: [
          { path: pngPath, kind: 'image' },
          { path: pdfPath, kind: 'pdf' },
        ],
      },
      silentLogger,
    );

    expect(result.pageCount).toBe(3);
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getWidth()).toBe(16);
    expect(doc.getPage(1).getWidth()).toBe(100);
    expect(doc.getPage(2).getWidth()).toBe(200);
  });

  it('skips corrupt images with a warning and continues', async () => {
    const good = await write('good.png', makeRandomGrayscalePng(16, 16));
    const bad = await write('bad.png', new Uint8Array([1, 2, 3, 4]));

    const result = await buildPdfForLeaf(
      {
        leafPath: dir,
        entries: [
          { path: good, kind: 'image' },
          { path: bad, kind: 'image' },
        ],
      },
      silentLogger,
    );

    expect(result.pageCount).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.name).toBe('bad.png');
  });

  it('throws when no entries produce pages', async () => {
    const bad = await write('bad.png', new Uint8Array([0]));
    await expect(
      buildPdfForLeaf({ leafPath: dir, entries: [{ path: bad, kind: 'image' }] }, silentLogger),
    ).rejects.toThrow(/No usable entries/);
  });

  it('skips unsupported extensions flagged as image', async () => {
    const webp = await write('x.webp', new Uint8Array([1, 2, 3]));
    const good = await write('1.png', makeRandomGrayscalePng(8, 8));
    const result = await buildPdfForLeaf(
      {
        leafPath: dir,
        entries: [
          { path: webp, kind: 'image' },
          { path: good, kind: 'image' },
        ],
      },
      silentLogger,
    );
    expect(result.pageCount).toBe(1);
    expect(result.skipped.map((s) => s.name)).toContain('x.webp');
  });
});
