import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants, mkdtemp, rm, stat } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { Logger } from '../logger.js';
import type { ProgressEvent, SourceFile } from '../types.js';

const POSIX_BINARIES = ['gs'] as const;
const WIN32_BINARIES = ['gswin64c.exe', 'gswin32c.exe', 'gs.exe'] as const;

const MAX_PARALLEL = 4;
const STDERR_TAIL_BYTES = 2048;

export class GhostscriptNotFoundError extends Error {
  readonly searchedBinaries: readonly string[];
  constructor(searched: readonly string[]) {
    const instructions = [
      '  macOS:   brew install ghostscript',
      '  Debian:  sudo apt install ghostscript',
      '  Windows: https://ghostscript.com/releases/',
    ].join('\n');
    super(
      `Ghostscript not found in PATH (looked for: ${searched.join(', ')}). Install with:\n${instructions}`,
    );
    this.name = 'GhostscriptNotFoundError';
    this.searchedBinaries = searched;
  }
}

export class GhostscriptFailedError extends Error {
  readonly file: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(file: string, exitCode: number | null, stderr: string) {
    const truncated =
      stderr.length > STDERR_TAIL_BYTES ? `…${stderr.slice(-STDERR_TAIL_BYTES)}` : stderr;
    super(`Ghostscript failed on ${file} (exit ${exitCode ?? 'null'}): ${truncated.trim()}`);
    this.name = 'GhostscriptFailedError';
    this.file = file;
    this.exitCode = exitCode;
    this.stderr = truncated;
  }
}

export interface NormalizeDeps {
  readonly spawn?: typeof spawn;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

async function findInPath(
  cmd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  if (!raw) return null;
  const mode = platform === 'win32' ? constants.F_OK : constants.X_OK;
  for (const dir of raw.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, cmd);
    try {
      await access(full, mode);
      return full;
    } catch {
      // try next PATH entry
    }
  }
  return null;
}

export async function resolveGhostscript(deps: NormalizeDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const candidates = platform === 'win32' ? WIN32_BINARIES : POSIX_BINARIES;
  for (const candidate of candidates) {
    const found = await findInPath(candidate, env, platform);
    if (found !== null) return found;
  }
  throw new GhostscriptNotFoundError([...candidates]);
}

export interface NormalizeOptions {
  readonly files: readonly SourceFile[];
  readonly logger: Logger;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly keepStaging?: boolean;
  readonly concurrency?: number;
  readonly binary?: string;
  readonly deps?: NormalizeDeps;
}

export interface NormalizeResult {
  readonly stagingDir: string;
  readonly files: readonly SourceFile[];
  readonly cleanup: () => Promise<void>;
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

interface NormalizeSpec {
  readonly index: number;
  readonly name: string;
  readonly inPath: string;
  readonly outPath: string;
}

/**
 * Re-serializes each source PDF through Ghostscript into a temporary staging
 * directory. Fixes the pdf-lib `copyPages` bug where documents with large
 * shared resources (image XObjects, fonts) leak the entire resource set into
 * every extracted page — without this step, `fitPagesToTarget` produces
 * dozens of single-page outputs that still exceed the target.
 *
 * Concurrency is bounded by `min(cpus().length, 4)`: gs is single-threaded
 * CPU-bound, but more than ~4 parallel instances saturate disk I/O without
 * improving wall time on typical hardware.
 *
 * Per-file failures are non-fatal: the file is recorded in `skipped` and the
 * batch continues, mirroring the `loadSourceMeta` policy. A single bad source
 * should not kill a 2-hour library processing run.
 */
export async function normalizeSources(options: NormalizeOptions): Promise<NormalizeResult> {
  const binary = options.binary ?? (await resolveGhostscript(options.deps));
  const spawnFn = options.deps?.spawn ?? spawn;
  const cpuCount = cpus().length;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? cpuCount, MAX_PARALLEL));
  const keep = options.keepStaging ?? false;

  const stagingDir = await mkdtemp(join(tmpdir(), 'skp-normalize-'));
  const specs: NormalizeSpec[] = options.files.map((f, i) => ({
    index: i,
    name: f.name,
    inPath: f.absolutePath,
    outPath: join(stagingDir, f.name),
  }));

  const skipped: { name: string; reason: string }[] = [];
  const completed = new Array<boolean>(specs.length).fill(false);
  const activeChildren = new Set<ChildProcess>();

  const sigintHandler = (): void => {
    for (const child of activeChildren) {
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
    }
  };
  process.on('SIGINT', sigintHandler);

  let nextEmit = 0;
  const flushProgress = (): void => {
    while (nextEmit < specs.length && completed[nextEmit]) {
      const spec = specs[nextEmit]!;
      options.onProgress?.({
        step: 'normalize',
        index: nextEmit + 1,
        total: specs.length,
        filename: spec.name,
      });
      nextEmit += 1;
    }
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const myIdx = cursor;
      cursor += 1;
      if (myIdx >= specs.length) return;
      const spec = specs[myIdx]!;
      try {
        await runGhostscript({ binary, spec, spawnFn, activeChildren });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn(`[skip] ${spec.name}: ${message}`);
        skipped.push({ name: spec.name, reason: message });
      }
      completed[myIdx] = true;
      flushProgress();
    }
  };

  try {
    const pool: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, specs.length); i += 1) {
      pool.push(worker());
    }
    await Promise.all(pool);
  } catch (error) {
    process.off('SIGINT', sigintHandler);
    if (!keep) {
      await rm(stagingDir, { recursive: true, force: true });
    }
    throw error;
  }

  process.off('SIGINT', sigintHandler);

  const normalizedFiles: SourceFile[] = [];
  for (const spec of specs) {
    if (skipped.some((s) => s.name === spec.name)) continue;
    try {
      const stats = await stat(spec.outPath);
      normalizedFiles.push({
        absolutePath: spec.outPath,
        name: spec.name,
        size: stats.size,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn(`[skip] ${spec.name}: normalized output missing (${message})`);
      skipped.push({ name: spec.name, reason: `normalized output missing: ${message}` });
    }
  }

  const cleanup = async (): Promise<void> => {
    if (!keep) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  };

  return { stagingDir, files: normalizedFiles, cleanup, skipped };
}

interface RunGhostscriptArgs {
  readonly binary: string;
  readonly spec: NormalizeSpec;
  readonly spawnFn: typeof spawn;
  readonly activeChildren: Set<ChildProcess>;
}

function runGhostscript(args: RunGhostscriptArgs): Promise<void> {
  const { binary, spec, spawnFn, activeChildren } = args;
  return new Promise((resolvePromise, rejectPromise) => {
    // `/ebook` downsamples images to 150 dpi and, crucially, materialises
    // document-level shared resources per-page — which is exactly what breaks
    // the pdf-lib `copyPages` bloat pattern. `/printer` and `/prepress`
    // preserve sharing (verified empirically on the shared-image fixture) and
    // therefore do NOT fix the bug they exist to fix. 150 dpi is above the
    // effective display density of a 6" Kindle Paperwhite, so the quality
    // loss is imperceptible for manga/comics; users who want pixel-perfect
    // output should simply not pass --normalize.
    const gsArgs = [
      '-sDEVICE=pdfwrite',
      '-dPDFSETTINGS=/ebook',
      '-dCompatibilityLevel=1.6',
      '-dNOPAUSE',
      '-dQUIET',
      '-dBATCH',
      '-dSAFER',
      `-sOutputFile=${spec.outPath}`,
      spec.inPath,
    ];
    let child: ChildProcess;
    try {
      child = spawnFn(binary, gsArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejectPromise(new GhostscriptFailedError(spec.name, null, message));
      return;
    }
    activeChildren.add(child);

    let stderrBuf = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > STDERR_TAIL_BYTES * 2) {
        stderrBuf = stderrBuf.slice(-STDERR_TAIL_BYTES * 2);
      }
    });
    child.on('error', (err: Error) => {
      activeChildren.delete(child);
      rejectPromise(new GhostscriptFailedError(spec.name, null, err.message));
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      activeChildren.delete(child);
      if (code === 0) {
        resolvePromise();
        return;
      }
      const tail = signal ? `${stderrBuf}\n(terminated by ${signal})` : stderrBuf;
      rejectPromise(new GhostscriptFailedError(spec.name, code, tail));
    });
  });
}
