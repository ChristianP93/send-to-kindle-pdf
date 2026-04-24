import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { orderBy } from 'natural-orderby';

import type { Logger } from '../logger.js';
import { classifyFile, isImageFile, isPdfFile } from './image-types.js';
import type { LeafEntry } from './images-to-pdf.js';

export type UnitKind = 'image-folder' | 'mixed-folder' | 'pdf-folder' | 'pdf-file';

export type DiscoveryMode = 'flat' | 'tree';

export interface LeafUnit {
  readonly label: string;
  readonly absolutePath: string;
  readonly kind: UnitKind;
  readonly entries: readonly LeafEntry[];
}

export interface TreeDiscoveryResult {
  readonly units: readonly LeafUnit[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  readonly mode: DiscoveryMode;
}

export interface TreeDiscoveryOptions {
  readonly inputDir: string;
  readonly logger: Logger;
  readonly outputDirName: string;
  readonly mode: DiscoveryMode | 'auto';
}

export class NoUnitsFoundError extends Error {
  constructor(dir: string) {
    super(`No PDF or image files found under "${dir}".`);
    this.name = 'NoUnitsFoundError';
  }
}

export const MAX_TREE_DEPTH = 32;
export const MAX_TREE_FILES = 50_000;

export class TreeDepthExceededError extends Error {
  constructor(dir: string, max: number) {
    super(`Maximum directory depth (${max}) exceeded at "${dir}".`);
    this.name = 'TreeDepthExceededError';
  }
}

export class TooManyFilesError extends Error {
  constructor(dir: string, max: number) {
    super(`Too many files discovered under "${dir}" (limit: ${max}).`);
    this.name = 'TooManyFilesError';
  }
}

interface DirEntry {
  readonly name: string;
  readonly absolutePath: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
}

async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    absolutePath: join(dir, e.name),
    isDirectory: e.isDirectory(),
    isFile: e.isFile(),
    isSymlink: e.isSymbolicLink(),
  }));
}

function classifyLeafKind(entries: readonly LeafEntry[]): UnitKind {
  const hasImage = entries.some((e) => e.kind === 'image');
  const hasPdf = entries.some((e) => e.kind === 'pdf');
  if (hasImage && hasPdf) return 'mixed-folder';
  if (hasImage) return 'image-folder';
  return 'pdf-folder';
}

function sortNatural<T>(items: T[], keyFn: (item: T) => string): T[] {
  return orderBy(items, [keyFn]);
}

function shouldTreatAsTree(rootEntries: readonly DirEntry[], outputDirName: string): boolean {
  const filteredDirs = rootEntries.filter(
    (e) => e.isDirectory && !e.isSymlink && e.name !== outputDirName,
  );
  const pdfsAtRoot = rootEntries.filter((e) => e.isFile && !e.isSymlink && isPdfFile(e.name));
  if (pdfsAtRoot.length > 0 && filteredDirs.length === 0) return false;
  return filteredDirs.length > 0;
}

export async function discoverTree(options: TreeDiscoveryOptions): Promise<TreeDiscoveryResult> {
  const { inputDir, logger, outputDirName, mode } = options;

  const rootEntries = await listDir(inputDir);

  let effectiveMode: DiscoveryMode;
  if (mode === 'auto') {
    effectiveMode = shouldTreatAsTree(rootEntries, outputDirName) ? 'tree' : 'flat';
  } else {
    effectiveMode = mode;
  }

  if (effectiveMode === 'flat') {
    return { units: [], skipped: [], mode: 'flat' };
  }

  const units: LeafUnit[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const counter = { files: 0 };

  await walk(inputDir, inputDir, outputDirName, logger, units, skipped, 0, counter);

  if (units.length === 0) {
    throw new NoUnitsFoundError(inputDir);
  }

  return { units, skipped, mode: 'tree' };
}

async function hasSubdirs(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.some((e) => e.isDirectory() && !e.isSymbolicLink());
}

async function walk(
  currentDir: string,
  rootDir: string,
  outputDirName: string,
  logger: Logger,
  units: LeafUnit[],
  skipped: { name: string; reason: string }[],
  depth: number,
  counter: { files: number },
): Promise<void> {
  if (depth > MAX_TREE_DEPTH) {
    throw new TreeDepthExceededError(currentDir, MAX_TREE_DEPTH);
  }
  const entries = await listDir(currentDir);
  const isRoot = currentDir === rootDir;

  for (const entry of entries) {
    if (entry.isSymlink) {
      const rel = relative(rootDir, entry.absolutePath);
      logger.warn(`[skip] ${rel}: symbolic link`);
      skipped.push({ name: rel, reason: 'symbolic link' });
    }
  }

  const subdirs = entries.filter(
    (e) => e.isDirectory && !e.isSymlink && !(isRoot && e.name === outputDirName),
  );
  const files = entries.filter((e) => e.isFile && !e.isSymlink);

  const sortedFiles = sortNatural(files, (e) => e.name);

  if (subdirs.length > 0) {
    // Branch-before-leaf ordering: at any level, directories that contain
    // further subdirectories are traversed before leaf directories. This is
    // what makes "Volume 01/capitolo-01" precede a sibling standalone
    // "Capitolo 168" — without it, natural sort alone would interleave them.
    const branches: DirEntry[] = [];
    const leaves: DirEntry[] = [];
    for (const sub of subdirs) {
      if (await hasSubdirs(sub.absolutePath)) {
        branches.push(sub);
      } else {
        leaves.push(sub);
      }
    }

    for (const branch of sortNatural(branches, (e) => e.name)) {
      await walk(
        branch.absolutePath,
        rootDir,
        outputDirName,
        logger,
        units,
        skipped,
        depth + 1,
        counter,
      );
    }
    for (const leaf of sortNatural(leaves, (e) => e.name)) {
      await walk(
        leaf.absolutePath,
        rootDir,
        outputDirName,
        logger,
        units,
        skipped,
        depth + 1,
        counter,
      );
    }

    // Root-level PDFs are emitted last so structured volumes/chapters come
    // first. Files inside a non-root branch are skipped: they could belong
    // to siblings or to the parent, and resolving that ambiguity is out of
    // scope (only leaf folders and root-level PDFs are supported inputs).
    for (const file of sortedFiles) {
      const rel = relative(rootDir, file.absolutePath);
      if (isRoot && isPdfFile(file.name)) {
        counter.files += 1;
        if (counter.files > MAX_TREE_FILES) {
          throw new TooManyFilesError(rootDir, MAX_TREE_FILES);
        }
        units.push({
          label: rel,
          absolutePath: file.absolutePath,
          kind: 'pdf-file',
          entries: [{ path: file.absolutePath, kind: 'pdf' }],
        });
      } else if (isPdfFile(file.name) || isImageFile(file.name)) {
        logger.warn(
          `[skip] ${rel}: file in a non-leaf folder (only leaf folders and root-level PDFs are supported)`,
        );
        skipped.push({ name: rel, reason: 'file inside non-leaf folder' });
      } else {
        logger.warn(`[skip] ${rel}: unsupported file`);
        skipped.push({ name: rel, reason: 'unsupported file' });
      }
    }
    return;
  }

  const leafEntries: LeafEntry[] = [];
  for (const file of sortedFiles) {
    const kind = classifyFile(file.name);
    if (kind === undefined) {
      const rel = relative(rootDir, file.absolutePath);
      logger.warn(`[skip] ${rel}: unsupported file`);
      skipped.push({ name: rel, reason: 'unsupported file' });
      continue;
    }
    counter.files += 1;
    if (counter.files > MAX_TREE_FILES) {
      throw new TooManyFilesError(rootDir, MAX_TREE_FILES);
    }
    leafEntries.push({ path: file.absolutePath, kind });
  }

  if (leafEntries.length === 0) {
    const rel = relative(rootDir, currentDir) || '.';
    logger.warn(`[skip] ${rel}: empty leaf folder`);
    skipped.push({ name: rel, reason: 'empty leaf folder' });
    return;
  }

  const rel = relative(rootDir, currentDir) || '.';
  units.push({
    label: rel,
    absolutePath: currentDir,
    kind: classifyLeafKind(leafEntries),
    entries: leafEntries,
  });
}
