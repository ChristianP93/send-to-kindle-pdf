import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { assemblePages, createSourceCache, fitPagesToTarget } from '../../src/core/sizer.js';
import { silentLogger } from '../../src/logger.js';
import type { SourcePageRef } from '../../src/types.js';

async function makePdf(
  pageCount: number,
  pageSize: [number, number] = [612, 792],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    doc.addPage(pageSize);
  }
  return doc.save({ useObjectStreams: true });
}

function refsFor(path: string, count: number): SourcePageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    sourcePath: path,
    sourceName: path.split('/').pop() ?? path,
    pageIndex: i,
  }));
}

describe('assemblePages', () => {
  it('assembles a PDF containing the requested pages', async () => {
    const bytes = await makePdf(10);
    const cache = createSourceCache(() => Promise.resolve(bytes));
    const result = await assemblePages(refsFor('/virtual/a.pdf', 5), cache);
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(5);
    expect(result.pageCount).toBe(5);
  });

  it('preserves page order across multiple sources', async () => {
    const a = await makePdf(3);
    const b = await makePdf(2);
    const cache = createSourceCache((path) => Promise.resolve(path === '/virtual/a.pdf' ? a : b));

    const pages: SourcePageRef[] = [
      ...refsFor('/virtual/a.pdf', 3),
      ...refsFor('/virtual/b.pdf', 2),
    ];
    const result = await assemblePages(pages, cache);
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(5);
  });

  it('throws on empty page list', async () => {
    const cache = createSourceCache(() => Promise.resolve(new Uint8Array()));
    await expect(assemblePages([], cache)).rejects.toThrow();
  });
});

describe('fitPagesToTarget', () => {
  it('returns all pages when fully under target', async () => {
    const bytes = await makePdf(20);
    const cache = createSourceCache(() => Promise.resolve(bytes));

    const result = await fitPagesToTarget({
      pages: refsFor('/virtual/a.pdf', 20),
      targetBytes: 10 * 1024 * 1024,
      cache,
      logger: silentLogger,
      chunkLabel: 'test',
    });
    expect(result.overflow).toHaveLength(0);
    expect(result.pages).toHaveLength(20);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  it('trims pages and reports overflow when above target', async () => {
    const bytes = await makePdf(50);
    const cache = createSourceCache(() => Promise.resolve(bytes));
    const { bytes: full } = await assemblePages(refsFor('/virtual/a.pdf', 50), cache);
    const target = Math.floor(full.byteLength * 0.7);

    const result = await fitPagesToTarget({
      pages: refsFor('/virtual/a.pdf', 50),
      targetBytes: target,
      cache,
      logger: silentLogger,
      chunkLabel: 'test',
    });
    expect(result.bytes.byteLength).toBeLessThanOrEqual(target);
    expect(result.pages.length + result.overflow.length).toBe(50);
    expect(result.overflow.length).toBeGreaterThan(0);
  });

  it('emits a single page even if it exceeds target (pathological case)', async () => {
    const bytes = await makePdf(1);
    const cache = createSourceCache(() => Promise.resolve(bytes));

    const result = await fitPagesToTarget({
      pages: refsFor('/virtual/a.pdf', 1),
      targetBytes: 10,
      cache,
      logger: silentLogger,
      chunkLabel: 'test',
    });
    expect(result.pages).toHaveLength(1);
    expect(result.overflow).toHaveLength(0);
  });
});
