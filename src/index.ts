import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';

import { discoverPdfFiles, NoPdfFoundError } from './core/discovery.js';
import { buildPdfForLeaf } from './core/images-to-pdf.js';
import { planChunks, type PlannerSource } from './core/planner.js';
import { createSourceCache, fitPagesToTarget } from './core/sizer.js';
import { discoverTree, type LeafUnit } from './core/tree-discovery.js';
import { createLogger, silentLogger, type Logger } from './logger.js';
import { createNameGenerator, validatePadding, validatePrefix } from './naming.js';
import type {
  PlanEntry,
  PrepareForKindleOptions,
  PrepareForKindleResult,
  ProgressEvent,
  RunMode,
  RunSummary,
  SourcePageRef,
} from './types.js';

export * from './types.js';
export {
  discoverPdfFiles,
  NoPdfFoundError,
  InputDirectoryError,
  TooManyFlatFilesError,
} from './core/discovery.js';
export {
  discoverTree,
  NoUnitsFoundError,
  TreeDepthExceededError,
  TooManyFilesError,
} from './core/tree-discovery.js';
export { buildPdfForLeaf } from './core/images-to-pdf.js';
export {
  CounterOverflowError,
  InvalidPaddingError,
  InvalidPrefixError,
  validatePrefix,
} from './naming.js';

const MEGABYTE = 1024 * 1024;
const LIMIT_MB = 200;
const MAX_PDF_BYTES = 1024 * MEGABYTE;

export class TargetSizeError extends Error {
  constructor(targetMb: number) {
    super(`Invalid --target-size ${targetMb}: must be an integer between 1 and ${LIMIT_MB - 1}.`);
    this.name = 'TargetSizeError';
  }
}

export class OutputDirExistsError extends Error {
  constructor(readonly path: string) {
    super(`Output directory already exists: ${path}. Use --force to overwrite.`);
    this.name = 'OutputDirExistsError';
  }
}

export class NoReadablePdfsError extends Error {
  constructor(
    readonly mode: RunMode,
    readonly skipped: readonly { readonly name: string; readonly reason: string }[],
  ) {
    const detail =
      skipped.length > 0
        ? ` Skipped ${skipped.length}: ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}.`
        : '';
    const suffix =
      mode === 'tree'
        ? 'No leaf unit produced a readable PDF.'
        : 'All discovered PDFs failed to load.';
    super(`${suffix}${detail}`);
    this.name = 'NoReadablePdfsError';
  }
}

function emit(listener: ((e: ProgressEvent) => void) | undefined, event: ProgressEvent): void {
  if (listener) listener(event);
}

interface NormalizedOptions {
  readonly inputDir: string;
  readonly prefix: string;
  readonly targetBytes: number;
  readonly outputDirName: string;
  readonly padding: number;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly mode: RunMode | 'auto';
  readonly keepStaging: boolean;
  readonly logger: Logger;
}

function normalizeOptions(options: PrepareForKindleOptions): NormalizedOptions {
  const targetMb = options.targetSizeMb ?? 180;
  if (!Number.isFinite(targetMb) || targetMb < 1 || targetMb >= LIMIT_MB) {
    throw new TargetSizeError(targetMb);
  }
  const padding = options.padding ?? 4;
  validatePrefix(options.prefix);
  validatePadding(padding);
  return {
    inputDir: resolve(options.inputDir),
    prefix: options.prefix,
    targetBytes: Math.floor(targetMb * MEGABYTE),
    outputDirName: options.outputDir ?? 'output',
    padding,
    force: options.force ?? false,
    dryRun: options.dryRun ?? false,
    mode: options.mode ?? 'auto',
    keepStaging: options.keepStaging ?? false,
    logger: options.verbose ? createLogger({ verbose: true }) : createLogger(),
  };
}

async function prepareOutputDir(outputDir: string, force: boolean, logger: Logger): Promise<void> {
  try {
    const stats = await stat(outputDir);
    if (stats.isDirectory()) {
      if (!force) {
        throw new OutputDirExistsError(outputDir);
      }
      logger.debug(`[io] removing existing output dir ${outputDir}`);
      await rm(outputDir, { recursive: true, force: true });
    } else {
      throw new Error(`Output path exists and is not a directory: ${outputDir}`);
    }
  } catch (error) {
    if (error instanceof OutputDirExistsError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') throw error;
  }
  await mkdir(outputDir, { recursive: true });
}

async function loadSourceMeta(
  files: readonly { absolutePath: string; name: string; size: number }[],
  logger: Logger,
): Promise<{
  readonly plannerSources: PlannerSource[];
  readonly skipped: { name: string; reason: string }[];
}> {
  const plannerSources: PlannerSource[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const file of files) {
    if (file.size > MAX_PDF_BYTES) {
      const reason = `PDF exceeds ${MAX_PDF_BYTES / MEGABYTE} MB limit`;
      logger.warn(`[skip] ${file.name}: ${reason}`);
      skipped.push({ name: file.name, reason });
      continue;
    }
    try {
      const bytes = await readFile(file.absolutePath);
      const doc = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        throwOnInvalidObject: false,
      });
      const pageCount = doc.getPageCount();
      if (pageCount === 0) {
        logger.warn(`[skip] ${file.name}: PDF has zero pages`);
        skipped.push({ name: file.name, reason: 'empty PDF' });
        continue;
      }
      plannerSources.push({
        name: file.name,
        absolutePath: file.absolutePath,
        size: file.size,
        pageCount,
      });
    } catch (error) {
      const message = String((error as { message?: string })?.message ?? error);
      logger.warn(`[skip] ${file.name}: ${message}`);
      skipped.push({ name: file.name, reason: message });
    }
  }

  return { plannerSources, skipped };
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

interface StageResult {
  readonly stagingDir: string;
  readonly cleanup: () => Promise<void>;
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

async function preStageUnits(
  units: readonly LeafUnit[],
  padding: number,
  logger: Logger,
  keepStaging: boolean,
  onProgress: ((e: ProgressEvent) => void) | undefined,
): Promise<StageResult> {
  const stagingDir = await mkdtemp(join(tmpdir(), 'skp-stage-'));
  const skipped: { name: string; reason: string }[] = [];
  const padWidth = Math.max(padding, String(units.length).length);

  try {
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i]!;
      const index = i + 1;
      emit(onProgress, { step: 'stage', index, total: units.length, label: unit.label });

      const safeName = sanitizeLabel(unit.label);
      const filename = `${String(index).padStart(padWidth, '0')}-${safeName}.pdf`;
      const outPath = join(stagingDir, filename);

      if (unit.kind === 'pdf-file') {
        const bytes = await readFile(unit.absolutePath);
        await writeFile(outPath, bytes);
        continue;
      }

      try {
        const result = await buildPdfForLeaf(
          { leafPath: unit.absolutePath, entries: unit.entries },
          logger,
        );
        await writeFile(outPath, result.bytes);
        for (const s of result.skipped) {
          skipped.push({ name: `${unit.label}/${s.name}`, reason: s.reason });
        }
      } catch (error) {
        const message = String((error as { message?: string })?.message ?? error);
        logger.warn(`[skip] ${unit.label}: ${message}`);
        skipped.push({ name: unit.label, reason: message });
      }
    }
  } catch (error) {
    if (!keepStaging) {
      await rm(stagingDir, { recursive: true, force: true });
    }
    throw error;
  }

  const cleanup = async (): Promise<void> => {
    if (!keepStaging) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  };

  return { stagingDir, cleanup, skipped };
}

/**
 * Prepare a directory of PDFs (or image folders) for upload to Amazon Send to Kindle.
 *
 * Two discovery modes:
 * - **flat**: `inputDir` contains `.pdf` files at its top level (v0.1 behaviour);
 * - **tree**: `inputDir` contains subfolders. Each leaf folder (no children)
 *   becomes one *unit*. Image files (jpg/png) inside a leaf are converted to
 *   PDF pages at 1:1 pixel size; `.pdf` files inside a leaf are concatenated.
 *   Branches (folders containing subfolders) are traversed first — so "Volume
 *   01/capitolo-01" comes before standalone "Capitolo 168".
 *
 * By default the mode is auto-detected from the input directory.
 *
 * Once units are pre-staged as PDFs in a temporary directory, the existing
 * packing/splitting pipeline runs unchanged.
 *
 * @example
 * ```ts
 * import { prepareForKindle } from 'send-to-kindle-pdf';
 *
 * const { summary } = await prepareForKindle({
 *   inputDir: '/path/to/manga',
 *   prefix: 'one-piece',
 *   targetSizeMb: 180,
 *   force: true,
 *   onProgress: (evt) => {
 *     if (evt.step === 'write') {
 *       console.log(`wrote ${evt.filename} (${evt.index}/${evt.total})`);
 *     }
 *   },
 * });
 *
 * console.log(`Produced ${summary.outputs.length} files in ${summary.outputDir}`);
 * ```
 *
 * @param options - input/output configuration and optional progress listener
 * @returns the execution `summary` and the final `plan` describing each output
 * @throws {TargetSizeError} when `targetSizeMb` is out of range (`< 1` or `>= 200`)
 * @throws {InvalidPrefixError} when `prefix` contains unsupported characters
 * @throws {InvalidPaddingError} when `padding` is not an integer between 1 and 9
 * @throws {NoPdfFoundError} when `inputDir` contains no readable PDFs (flat mode)
 * @throws {NoUnitsFoundError} when the tree contains no usable leaves (tree mode)
 * @throws {OutputDirExistsError} when the output directory already exists and `force` is `false`
 * @throws {CounterOverflowError} when the required counter exceeds `10^padding - 1`
 */
export async function prepareForKindle(
  options: PrepareForKindleOptions,
): Promise<PrepareForKindleResult> {
  const start = Date.now();
  const opts = normalizeOptions(options);
  const outputDir = join(opts.inputDir, opts.outputDirName);
  const nameFor = createNameGenerator({ prefix: opts.prefix, padding: opts.padding });

  const tree = await discoverTree({
    inputDir: opts.inputDir,
    logger: opts.logger,
    outputDirName: opts.outputDirName,
    mode: opts.mode,
  });

  const runMode: RunMode = tree.mode;
  let stageCleanup: (() => Promise<void>) | undefined;
  let stagingDir: string | undefined;
  let treeSkipped: { name: string; reason: string }[] = [...tree.skipped];

  let discoveryDir = opts.inputDir;

  try {
    if (runMode === 'tree') {
      // Tree mode is implemented as a pre-stage that materializes each leaf
      // as a single PDF in a temp dir, then re-points `discoveryDir` at it.
      // The rest of the pipeline (discovery → plan → write) runs against the
      // staging dir as if it were a flat input — there is no tree-aware code
      // downstream of this block, which is why the staging label encodes the
      // sort order in the filename (NNNN-<label>.pdf).
      opts.logger.info(`[info] mode: tree — ${tree.units.length} leaf unit(s) detected`);
      const stage = await preStageUnits(
        tree.units,
        opts.padding,
        opts.logger,
        opts.keepStaging,
        options.onProgress,
      );
      stagingDir = stage.stagingDir;
      stageCleanup = stage.cleanup;
      treeSkipped = [...treeSkipped, ...stage.skipped];
      discoveryDir = stage.stagingDir;
      opts.logger.debug(`[io] staged ${tree.units.length} units in ${stage.stagingDir}`);
    } else {
      opts.logger.info('[info] mode: flat');
    }

    let discovery;
    try {
      discovery = await discoverPdfFiles({
        inputDir: discoveryDir,
        logger: opts.logger,
      });
    } catch (error) {
      if (runMode === 'tree' && error instanceof NoPdfFoundError) {
        throw new NoReadablePdfsError('tree', treeSkipped);
      }
      throw error;
    }
    emit(options.onProgress, {
      step: 'discovery',
      mode: runMode,
      files: discovery.files.length,
    });

    const { plannerSources, skipped: loadSkipped } = await loadSourceMeta(
      discovery.files,
      opts.logger,
    );

    if (plannerSources.length === 0) {
      throw new NoReadablePdfsError(runMode, [
        ...treeSkipped,
        ...discovery.skipped,
        ...loadSkipped,
      ]);
    }

    const plan = planChunks({
      sources: plannerSources,
      targetBytes: opts.targetBytes,
      nameFor,
    });
    emit(options.onProgress, { step: 'plan', chunks: plan.length });

    const inputTotalBytes = discovery.files.reduce((acc, f) => acc + f.size, 0);
    const skippedAll = [...treeSkipped, ...discovery.skipped, ...loadSkipped];

    if (opts.dryRun) {
      emit(options.onProgress, { step: 'done', outputs: plan.map((p) => p.outputName) });
      const summary: RunSummary = {
        mode: runMode,
        inputCount: discovery.files.length,
        inputTotalBytes,
        outputDir,
        outputs: plan.map((p) => ({ name: p.outputName, bytes: p.estimatedBytes })),
        skipped: skippedAll,
        ...(stagingDir !== undefined ? { stagingDir } : {}),
        elapsedMs: Date.now() - start,
      };
      return { summary, plan };
    }

    await prepareOutputDir(outputDir, opts.force, opts.logger);

    const cache = createSourceCache(async (path) => {
      const buf = await readFile(path);
      return new Uint8Array(buf);
    });

    const queue: SourcePageRef[][] = plan.map((entry) => [...entry.pages]);
    const actualOutputs: { name: string; bytes: number }[] = [];
    const writtenPlan: PlanEntry[] = [];
    let outputIndex = 0;
    let emittedTotal = plan.length;

    try {
      while (queue.length > 0) {
        const pages = queue.shift();
        if (!pages || pages.length === 0) continue;

        outputIndex += 1;
        const filename = nameFor(outputIndex);
        const chunkLabel = filename;

        const title = filename.replace(/\.pdf$/i, '');
        const fit = await fitPagesToTarget({
          pages,
          targetBytes: opts.targetBytes,
          cache,
          logger: opts.logger,
          chunkLabel,
          title,
        });

        const outPath = join(outputDir, filename);
        await writeFile(outPath, fit.bytes);

        actualOutputs.push({ name: filename, bytes: fit.bytes.byteLength });
        writtenPlan.push({
          outputIndex,
          outputName: filename,
          pages: fit.pages,
          estimatedBytes: fit.bytes.byteLength,
          sources: [...new Set(fit.pages.map((p) => p.sourceName))],
        });

        // Pages dropped by fitPagesToTarget are merged into the head of the
        // next queued chunk so they remain in source order. If the queue is
        // empty, the overflow becomes a brand-new chunk on its own. This is
        // the mechanism that lets a planner estimate be too generous without
        // losing pages — sizing is reconciled at write time, not plan time.
        if (fit.overflow.length > 0) {
          if (queue.length > 0) {
            const next = queue.shift() ?? [];
            queue.unshift([...fit.overflow, ...next]);
          } else {
            queue.unshift([...fit.overflow]);
          }
        }

        // `total` must be monotonically non-decreasing for progress UIs:
        // overflow can grow the queue beyond the original `plan.length`, so
        // we ratchet up but never down (an inner `continue` on an empty
        // chunk could otherwise shrink `outputIndex + queue.length`).
        emittedTotal = Math.max(emittedTotal, outputIndex + queue.length);
        emit(options.onProgress, {
          step: 'write',
          index: outputIndex,
          total: emittedTotal,
          filename,
        });
      }
    } finally {
      cache.clear();
    }

    emit(options.onProgress, { step: 'done', outputs: actualOutputs.map((o) => o.name) });

    const summary: RunSummary = {
      mode: runMode,
      inputCount: discovery.files.length,
      inputTotalBytes,
      outputDir,
      outputs: actualOutputs,
      skipped: skippedAll,
      ...(stagingDir !== undefined ? { stagingDir } : {}),
      elapsedMs: Date.now() - start,
    };

    return { summary, plan: writtenPlan };
  } finally {
    if (stageCleanup) {
      try {
        await stageCleanup();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export { silentLogger, createLogger };
