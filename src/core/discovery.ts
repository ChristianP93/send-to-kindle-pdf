import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { orderBy } from 'natural-orderby';

import type { Logger } from '../logger.js';
import type { SourceFile } from '../types.js';

export interface DiscoveryResult {
  readonly files: readonly SourceFile[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

export interface DiscoveryOptions {
  readonly inputDir: string;
  readonly logger: Logger;
}

export class InputDirectoryError extends Error {
  constructor(dir: string, cause: unknown) {
    super(
      `Cannot read input directory "${dir}": ${String((cause as { message?: string })?.message ?? cause)}`,
    );
    this.name = 'InputDirectoryError';
  }
}

export class NoPdfFoundError extends Error {
  constructor(dir: string) {
    super(`No PDF files found in "${dir}".`);
    this.name = 'NoPdfFoundError';
  }
}

export const MAX_FLAT_FILES = 50_000;

export class TooManyFlatFilesError extends Error {
  constructor(dir: string, max: number) {
    super(`Too many entries in "${dir}" (limit: ${max}).`);
    this.name = 'TooManyFlatFilesError';
  }
}

export async function discoverPdfFiles(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const { inputDir, logger } = options;

  let entries: string[];
  try {
    entries = await readdir(inputDir);
  } catch (error) {
    throw new InputDirectoryError(inputDir, error);
  }

  if (entries.length > MAX_FLAT_FILES) {
    throw new TooManyFlatFilesError(inputDir, MAX_FLAT_FILES);
  }

  const pdfs: SourceFile[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const entry of entries) {
    const absolutePath = join(inputDir, entry);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      logger.warn(
        `[skip] ${entry}: cannot stat (${String((error as { message?: string })?.message ?? error)})`,
      );
      skipped.push({ name: entry, reason: 'stat failed' });
      continue;
    }

    if (stats.isSymbolicLink()) {
      logger.warn(`[skip] ${entry}: symbolic link`);
      skipped.push({ name: entry, reason: 'symbolic link' });
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    if (!entry.toLowerCase().endsWith('.pdf')) {
      logger.warn(`[skip] ${entry}: not a PDF`);
      skipped.push({ name: entry, reason: 'not a PDF' });
      continue;
    }

    pdfs.push({
      absolutePath,
      name: entry,
      size: stats.size,
    });
  }

  if (pdfs.length === 0) {
    throw new NoPdfFoundError(inputDir);
  }

  const sorted = orderBy(pdfs, [(f) => f.name]);

  return { files: sorted, skipped };
}
