import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';

// Evaluated at module load so `it.skipIf` sees the correct value during
// collection. An async `beforeAll` probe is set too late — vitest decides
// whether to skip a test when the test is registered, not when it runs.
const gsAvailable = (() => {
  try {
    const result = spawnSync('gs', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
})();

describe('integration: --normalize (real Ghostscript)', () => {
  let input: string;

  beforeAll(async () => {
    if (gsAvailable) {
      await ensureFixtures();
    }
  }, 600_000);

  beforeEach(async () => {
    input = await mkdtemp(join(tmpdir(), 'sk-normalize-'));
  });

  afterEach(async () => {
    await rm(input, { recursive: true, force: true });
  });

  it.skipIf(!gsAvailable)(
    'breaks pdf-lib shared-resource bloat (per-page extract ≫ batch extract without normalize, parity with normalize)',
    async () => {
      await copyFile(
        join(FIXTURE_DIR, 'shared-image-bloat.pdf'),
        join(input, 'shared-image-bloat.pdf'),
      );

      // Baseline: per-page extract size when the fixture is packed one page per
      // output. This proves the fixture actually triggers the bug.
      const srcBytes = await readFile(join(input, 'shared-image-bloat.pdf'));
      const srcDoc = await PDFDocument.load(srcBytes);
      const unnormalizedSinglePage = await (async (): Promise<number> => {
        const out = await PDFDocument.create();
        const [p] = await out.copyPages(srcDoc, [0]);
        out.addPage(p);
        const saved = await out.save({ useObjectStreams: true });
        return saved.byteLength;
      })();
      // Fixture sanity: a 1-page extract should be within 20% of the whole file.
      expect(unnormalizedSinglePage / srcBytes.byteLength).toBeGreaterThan(0.8);

      const { summary: norm } = await prepareForKindle({
        inputDir: input,
        prefix: 'bloat',
        targetSizeMb: 1,
        force: true,
        normalize: true,
      });

      // After normalization, per-page extract of the (normalized) file should
      // shrink dramatically because /ebook materialises the shared image
      // into something that `copyPages` can isolate.
      expect(norm.outputs.length).toBe(1);
      const outPath = join(input, 'output', norm.outputs[0]!.name);
      const s = await stat(outPath);
      // Normalized single-output total must be well below what an un-normalized
      // 1-page extract would produce. A 4× reduction is a conservative bound.
      expect(s.size).toBeLessThan(unnormalizedSinglePage / 4);
    },
    120_000,
  );

  it.skipIf(!gsAvailable)('emits normalize progress events in input order', async () => {
    await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(input, 'a.pdf'));
    await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(input, 'b.pdf'));
    await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(input, 'c.pdf'));

    const normalizeFilenames: string[] = [];
    await prepareForKindle({
      inputDir: input,
      prefix: 'np',
      targetSizeMb: 10,
      force: true,
      normalize: true,
      onProgress: (e) => {
        if (e.step === 'normalize') normalizeFilenames.push(e.filename);
      },
    });

    expect(normalizeFilenames).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  }, 120_000);

  it.skipIf(!gsAvailable)('preserves the staging dir when --keep-staging is set', async () => {
    await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(input, 'a.pdf'));

    const { summary } = await prepareForKindle({
      inputDir: input,
      prefix: 'ks',
      targetSizeMb: 10,
      force: true,
      normalize: true,
      keepStaging: true,
    });

    expect(summary.stagingDir).toBeTruthy();
    const kept = await stat(summary.stagingDir!);
    expect(kept.isDirectory()).toBe(true);
    await rm(summary.stagingDir!, { recursive: true, force: true });
  }, 120_000);
});
