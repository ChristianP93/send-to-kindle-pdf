import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn as SpawnFn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GhostscriptFailedError,
  GhostscriptNotFoundError,
  normalizeSources,
  resolveGhostscript,
} from '../../src/core/normalize.js';
import { createLogger, silentLogger } from '../../src/logger.js';
import type { ProgressEvent, SourceFile } from '../../src/types.js';

const isWindows = platform() === 'win32';

interface FakeOptions {
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly emitError?: Error;
  readonly writeOutput?: boolean;
  readonly outputBytes?: Uint8Array;
  readonly delayMs?: number;
}

interface FakeSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

function makeFakeSpawn(
  decide: (call: FakeSpawnCall) => FakeOptions,
  onSpawn?: (call: FakeSpawnCall, child: FakeChild) => void,
): {
  spawn: typeof SpawnFn;
  calls: FakeSpawnCall[];
  active: Set<FakeChild>;
} {
  const calls: FakeSpawnCall[] = [];
  const active = new Set<FakeChild>();
  const spawn = ((command: string, args?: readonly string[]): ChildProcess => {
    const call: FakeSpawnCall = { command, args: args ?? [] };
    calls.push(call);
    const opts = decide(call);
    const child = new FakeChild(opts, call);
    active.add(child);
    child.once('exit', () => active.delete(child));
    onSpawn?.(call, child);
    // Run async so the promise chain has a chance to wire up listeners.
    setImmediate(() => {
      void child.run();
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof SpawnFn;
  return { spawn, calls, active };
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  private killed = false;

  constructor(
    private readonly opts: FakeOptions,
    private readonly call: FakeSpawnCall,
  ) {
    super();
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
    return true;
  }

  async run(): Promise<void> {
    if (this.killed) return;
    if (this.opts.emitError) {
      this.emit('error', this.opts.emitError);
      return;
    }
    if (this.opts.stderr) {
      this.stderr.write(this.opts.stderr);
    }
    this.stderr.end();
    this.stdout.end();
    if (this.opts.delayMs) {
      await new Promise<void>((r) => {
        setTimeout(r, this.opts.delayMs);
      });
    }
    if (this.killed) return;
    const code = this.opts.exitCode ?? 0;
    if (code === 0 && this.opts.writeOutput !== false) {
      const outArg = this.call.args.find((a) => a.startsWith('-sOutputFile='));
      if (outArg) {
        const path = outArg.slice('-sOutputFile='.length);
        const bytes = this.opts.outputBytes ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
        await writeFile(path, bytes);
      }
    }
    this.emit('exit', code, null);
  }
}

async function writeStubExecutable(dir: string, name: string): Promise<string> {
  const full = join(dir, name);
  await writeFile(full, '#!/bin/sh\nexit 0\n');
  if (!isWindows) await chmod(full, 0o755);
  return full;
}

describe('resolveGhostscript', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'norm-resolve-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(isWindows)('finds gs when present on PATH (posix)', async () => {
    const binDir = join(root, 'bin');
    await mkdir(binDir);
    const gsPath = await writeStubExecutable(binDir, 'gs');
    const resolved = await resolveGhostscript({
      env: { PATH: binDir },
      platform: 'linux',
    });
    expect(resolved).toBe(gsPath);
  });

  it('throws GhostscriptNotFoundError when no candidate is found', async () => {
    const emptyDir = join(root, 'empty');
    await mkdir(emptyDir);
    await expect(
      resolveGhostscript({ env: { PATH: emptyDir }, platform: 'linux' }),
    ).rejects.toBeInstanceOf(GhostscriptNotFoundError);
  });

  it('searches win32 candidates when platform is win32', async () => {
    const binDir = join(root, 'winbin');
    await mkdir(binDir);
    await writeFile(join(binDir, 'gswin64c.exe'), 'stub');
    const resolved = await resolveGhostscript({
      env: { PATH: binDir },
      platform: 'win32',
    });
    expect(resolved.endsWith('gswin64c.exe')).toBe(true);
  });

  it('handles missing PATH env gracefully', async () => {
    await expect(resolveGhostscript({ env: {}, platform: 'linux' })).rejects.toBeInstanceOf(
      GhostscriptNotFoundError,
    );
  });
});

async function makeSourceFiles(dir: string, names: readonly string[]): Promise<SourceFile[]> {
  const result: SourceFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    await writeFile(path, 'pdf-content-stub');
    const s = await stat(path);
    result.push({ absolutePath: path, name, size: s.size });
  }
  return result;
}

describe('normalizeSources', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'norm-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes expected gs argv for each file', async () => {
    const files = await makeSourceFiles(root, ['a.pdf', 'b.pdf']);
    const { spawn, calls } = makeFakeSpawn(() => ({ exitCode: 0 }));

    const result = await normalizeSources({
      files,
      logger: silentLogger,
      binary: '/opt/gs',
      deps: { spawn },
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe('/opt/gs');
      expect(call.args).toContain('-sDEVICE=pdfwrite');
      expect(call.args).toContain('-dPDFSETTINGS=/ebook');
      expect(call.args).toContain('-dNOPAUSE');
      expect(call.args).toContain('-dBATCH');
      expect(call.args).toContain('-dSAFER');
      expect(call.args.find((a) => a.startsWith('-sOutputFile='))).toBeDefined();
    }
    expect(result.files).toHaveLength(2);
    expect(result.skipped).toEqual([]);

    await result.cleanup();
  });

  it('emits progress events in input order regardless of completion order', async () => {
    const files = await makeSourceFiles(root, ['a.pdf', 'b.pdf', 'c.pdf']);
    // c finishes first, then b, then a — events must still be emitted a, b, c.
    const delays: Record<string, number> = { 'a.pdf': 40, 'b.pdf': 20, 'c.pdf': 5 };
    const { spawn } = makeFakeSpawn((call) => {
      const out = call.args.find((a) => a.startsWith('-sOutputFile='))!;
      const name = basename(out);
      return { exitCode: 0, delayMs: delays[name] ?? 0 };
    });

    const events: ProgressEvent[] = [];
    const result = await normalizeSources({
      files,
      logger: silentLogger,
      binary: 'gs',
      concurrency: 3,
      deps: { spawn },
      onProgress: (e) => events.push(e),
    });

    const normalizeEvents = events.filter((e) => e.step === 'normalize');
    expect(normalizeEvents.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(normalizeEvents.map((e) => (e as { filename: string }).filename)).toEqual([
      'a.pdf',
      'b.pdf',
      'c.pdf',
    ]);

    await result.cleanup();
  });

  it('records per-file failures as skipped and continues the batch', async () => {
    const files = await makeSourceFiles(root, ['ok.pdf', 'bad.pdf', 'also-ok.pdf']);
    const { spawn } = makeFakeSpawn((call) => {
      const out = call.args.find((a) => a.startsWith('-sOutputFile='))!;
      if (out.endsWith('bad.pdf')) {
        return { exitCode: 1, stderr: 'simulated gs crash', writeOutput: false };
      }
      return { exitCode: 0 };
    });

    const result = await normalizeSources({
      files,
      logger: silentLogger,
      binary: 'gs',
      deps: { spawn },
    });

    expect(result.files.map((f) => f.name).sort()).toEqual(['also-ok.pdf', 'ok.pdf']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.name).toBe('bad.pdf');
    expect(result.skipped[0]!.reason).toContain('simulated gs crash');

    await result.cleanup();
  });

  it('respects concurrency: at most N gs processes spawn at once', async () => {
    const files = await makeSourceFiles(root, [
      '1.pdf',
      '2.pdf',
      '3.pdf',
      '4.pdf',
      '5.pdf',
      '6.pdf',
    ]);
    let peak = 0;
    let inFlight = 0;
    const { spawn } = makeFakeSpawn(
      () => ({ exitCode: 0, delayMs: 30 }),
      (_call, child) => {
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        child.once('exit', () => {
          inFlight -= 1;
        });
      },
    );

    const result = await normalizeSources({
      files,
      logger: silentLogger,
      binary: 'gs',
      concurrency: 2,
      deps: { spawn },
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(result.files).toHaveLength(6);
    await result.cleanup();
  });

  it('removes the staging dir on cleanup unless keepStaging is true', async () => {
    const files = await makeSourceFiles(root, ['a.pdf']);
    const { spawn } = makeFakeSpawn(() => ({ exitCode: 0 }));

    const result = await normalizeSources({
      files,
      logger: silentLogger,
      binary: 'gs',
      deps: { spawn },
    });
    await result.cleanup();
    await expect(stat(result.stagingDir)).rejects.toHaveProperty('code', 'ENOENT');

    const kept = await normalizeSources({
      files,
      logger: silentLogger,
      binary: 'gs',
      keepStaging: true,
      deps: { spawn },
    });
    await kept.cleanup();
    const s = await stat(kept.stagingDir);
    expect(s.isDirectory()).toBe(true);
    await rm(kept.stagingDir, { recursive: true, force: true });
  });

  it('surfaces spawn errors via GhostscriptFailedError.skipped', async () => {
    const files = await makeSourceFiles(root, ['a.pdf']);
    const { spawn } = makeFakeSpawn(() => ({
      emitError: new Error('ENOENT: no such binary'),
    }));

    const result = await normalizeSources({
      files,
      logger: silentLogger,
      binary: '/no/such/gs',
      deps: { spawn },
    });

    expect(result.files).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('ENOENT');
    await result.cleanup();
  });

  it('records missing normalized output as skipped even if gs exited 0', async () => {
    const files = await makeSourceFiles(root, ['a.pdf']);
    const { stream } = captureWarnStream();
    const logger = createLogger({ stream, verbose: false });
    const { spawn } = makeFakeSpawn(() => ({ exitCode: 0, writeOutput: false }));
    const result = await normalizeSources({
      files,
      logger,
      binary: 'gs',
      deps: { spawn },
    });
    expect(result.files).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('normalized output missing');
    await result.cleanup();
  });

  it('exposes GhostscriptFailedError fields for error instances', () => {
    const err = new GhostscriptFailedError('file.pdf', 2, 'boom');
    expect(err.file).toBe('file.pdf');
    expect(err.exitCode).toBe(2);
    expect(err.stderr).toBe('boom');
    expect(err.name).toBe('GhostscriptFailedError');
  });

  it('exposes GhostscriptNotFoundError.searchedBinaries', () => {
    const err = new GhostscriptNotFoundError(['gs', 'gswin64c.exe']);
    expect(err.searchedBinaries).toEqual(['gs', 'gswin64c.exe']);
    expect(err.name).toBe('GhostscriptNotFoundError');
    expect(err.message).toContain('brew install ghostscript');
  });
});

function captureWarnStream(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
}
