import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';

import {
  NoReadablePdfsError,
  OutputDirExistsError,
  TargetSizeError,
  prepareForKindle,
} from './index.js';
import { createCliProgress } from './cli-progress.js';
import { NoPdfFoundError, InputDirectoryError } from './core/discovery.js';
import { NoUnitsFoundError } from './core/tree-discovery.js';
import { CounterOverflowError, InvalidPaddingError, InvalidPrefixError } from './naming.js';

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_INVALID_ARGS = 2;

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, '..', 'package.json'), join(here, 'package.json')];
    for (const candidate of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // try next
      }
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

function parseIntArg(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || String(n) !== value.trim()) {
    throw new InvalidArgumentError(`${name} must be an integer, received "${value}"`);
  }
  return n;
}

function parseModeArg(value: string): 'flat' | 'tree' | 'auto' {
  if (value === 'flat' || value === 'tree' || value === 'auto') return value;
  throw new InvalidArgumentError(`--mode must be one of: auto, flat, tree (received "${value}")`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

async function main(argv: readonly string[]): Promise<number> {
  const program = new Command();
  program
    .name('send-to-kindle-pdf')
    .description(
      'Prepare PDFs for Amazon Send to Kindle: auto-merge small files and split large ones under the 200MB limit.',
    )
    .version(readVersion(), '-v, --version')
    .argument('<folder>', 'Path to the folder containing source PDFs')
    .argument('<prefix>', 'Prefix for output files (e.g. "one-piece")')
    .option(
      '--target-size <mb>',
      'Target size in MB (must be < 200)',
      (v) => parseIntArg(v, '--target-size'),
      180,
    )
    .option('--output-dir <name>', 'Output directory name inside <folder>', 'output')
    .option(
      '--padding <n>',
      'Zero-padding width for the counter',
      (v) => parseIntArg(v, '--padding'),
      4,
    )
    .option('--force', 'Overwrite the output directory if it exists', false)
    .option('--dry-run', 'Compute and print the plan without writing files', false)
    .option(
      '--mode <mode>',
      'Discovery mode: auto | flat | tree',
      (v) => parseModeArg(v),
      'auto' as 'auto' | 'flat' | 'tree',
    )
    .option('--keep-staging', 'Do not remove the temp staging directory (debug)', false)
    .option('--verbose', 'Verbose debug logging', false)
    .action(
      async (
        folder: string,
        prefix: string,
        opts: {
          targetSize: number;
          outputDir: string;
          padding: number;
          force: boolean;
          dryRun: boolean;
          mode: 'auto' | 'flat' | 'tree';
          keepStaging: boolean;
          verbose: boolean;
        },
      ) => {
        const onProgress = opts.verbose ? undefined : createCliProgress();
        const result = await prepareForKindle({
          inputDir: folder,
          prefix,
          targetSizeMb: opts.targetSize,
          outputDir: opts.outputDir,
          padding: opts.padding,
          force: opts.force,
          dryRun: opts.dryRun,
          mode: opts.mode,
          keepStaging: opts.keepStaging,
          verbose: opts.verbose,
          ...(onProgress ? { onProgress } : {}),
        });

        const { summary, plan } = result;
        const header = opts.dryRun ? 'Plan (dry run)' : 'Output';

        const lines: string[] = [];
        lines.push(
          `Input:   ${summary.inputCount} PDF (${formatBytes(summary.inputTotalBytes)} total) [mode: ${summary.mode}]`,
        );
        if (summary.stagingDir) {
          lines.push(`Staging: ${summary.stagingDir}`);
        }
        lines.push(`${header}:  ${summary.outputs.length} PDF in ${summary.outputDir}/`);
        for (const entry of summary.outputs) {
          lines.push(`  → ${entry.name}  (${formatBytes(entry.bytes)})`);
        }

        if (opts.dryRun && opts.verbose) {
          lines.push('');
          lines.push('Plan detail:');
          for (const p of plan) {
            lines.push(`  ${p.outputName}: ${p.pages.length} pages from ${p.sources.join(', ')}`);
          }
        }

        if (summary.skipped.length > 0) {
          const names = summary.skipped.map((s) => s.name).join(', ');
          lines.push(`Warning: ${summary.skipped.length} skipped (${names})`);
        }

        lines.push(`Time:    ${(summary.elapsedMs / 1000).toFixed(1)}s`);

        process.stdout.write(lines.join('\n') + '\n');
      },
    );

  try {
    await program.parseAsync(argv, { from: 'user' });
    return EXIT_OK;
  } catch (error) {
    return handleError(error);
  }
}

function handleError(error: unknown): number {
  if (
    error instanceof InvalidArgumentError ||
    error instanceof InvalidPrefixError ||
    error instanceof InvalidPaddingError ||
    error instanceof TargetSizeError
  ) {
    process.stderr.write(`error: ${error.message}\n`);
    return EXIT_INVALID_ARGS;
  }

  if (
    error instanceof NoPdfFoundError ||
    error instanceof NoUnitsFoundError ||
    error instanceof NoReadablePdfsError ||
    error instanceof InputDirectoryError ||
    error instanceof OutputDirExistsError ||
    error instanceof CounterOverflowError
  ) {
    process.stderr.write(`error: ${error.message}\n`);
    return EXIT_RUNTIME;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  return EXIT_RUNTIME;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(
      `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(EXIT_RUNTIME);
  },
);

export { main };
