import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { PDFDocument } from 'pdf-lib';

import type { Logger } from '../logger.js';
import { isImageFile, isPdfFile } from './image-types.js';

export interface LeafEntry {
  readonly path: string;
  readonly kind: 'image' | 'pdf';
}

export interface LeafUnitInput {
  readonly leafPath: string;
  readonly entries: readonly LeafEntry[];
}

export interface BuildResult {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

async function embedImageOnPage(
  output: PDFDocument,
  path: string,
  logger: Logger,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const bytes = await readFile(path);
    const name = basename(path);

    if (isImageFile(name)) {
      // Lossless embedding contract (advertised in the README):
      //  - JPEG bytes are stored verbatim by `embedJpg` (no decode/re-encode).
      //  - PNG pixels are decoded by pdf-lib and re-embedded as a Flate stream;
      //    pixel data is preserved bit-exact, no lossy step is applied.
      // The page is sized 1:1 to the image's pixel dimensions so Kindle's
      // fit-to-screen rendering scales without artifacts.
      const lower = name.toLowerCase();
      const isJpeg = lower.endsWith('.jpg') || lower.endsWith('.jpeg');
      const image = isJpeg
        ? await output.embedJpg(new Uint8Array(bytes))
        : await output.embedPng(new Uint8Array(bytes));

      const page = output.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      return { ok: true };
    }

    return { ok: false, reason: 'not an image' };
  } catch (error) {
    const reason = String((error as { message?: string })?.message ?? error);
    logger.warn(`[skip] ${basename(path)}: ${reason}`);
    return { ok: false, reason };
  }
}

async function appendPdfPages(
  output: PDFDocument,
  path: string,
  logger: Logger,
): Promise<{ ok: true; pages: number } | { ok: false; reason: string }> {
  try {
    const bytes = await readFile(path);
    const source = await PDFDocument.load(new Uint8Array(bytes), {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
    });
    const count = source.getPageCount();
    if (count === 0) {
      return { ok: false, reason: 'empty PDF' };
    }
    const indexes = Array.from({ length: count }, (_, i) => i);
    const copied = await output.copyPages(source, indexes);
    for (const page of copied) {
      output.addPage(page);
    }
    return { ok: true, pages: count };
  } catch (error) {
    const reason = String((error as { message?: string })?.message ?? error);
    logger.warn(`[skip] ${basename(path)}: ${reason}`);
    return { ok: false, reason };
  }
}

export async function buildPdfForLeaf(input: LeafUnitInput, logger: Logger): Promise<BuildResult> {
  const output = await PDFDocument.create();
  const skipped: { name: string; reason: string }[] = [];
  let pageCount = 0;

  for (const entry of input.entries) {
    const name = basename(entry.path);

    if (entry.kind === 'image') {
      const result = await embedImageOnPage(output, entry.path, logger);
      if (result.ok) {
        pageCount += 1;
      } else {
        skipped.push({ name, reason: result.reason });
      }
      continue;
    }

    if (entry.kind === 'pdf') {
      if (!isPdfFile(name)) {
        skipped.push({ name, reason: 'not a PDF' });
        continue;
      }
      const result = await appendPdfPages(output, entry.path, logger);
      if (result.ok) {
        pageCount += result.pages;
      } else {
        skipped.push({ name, reason: result.reason });
      }
      continue;
    }
  }

  if (pageCount === 0) {
    throw new Error(`No usable entries in leaf "${input.leafPath}"`);
  }

  const bytes = await output.save({ useObjectStreams: true });
  return { bytes, pageCount, skipped };
}
