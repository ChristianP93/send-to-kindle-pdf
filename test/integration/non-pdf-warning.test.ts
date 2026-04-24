import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';

describe('integration: non-PDF files are skipped with a warning', () => {
  let workDir: string;

  beforeAll(async () => {
    await ensureFixtures();
  }, 600_000);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sk-nonpdf-'));
    await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(workDir, 'chapter.pdf'));
    await writeFile(join(workDir, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(join(workDir, 'notes.txt'), 'hello');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('processes PDFs and reports the skipped files', async () => {
    const { summary } = await prepareForKindle({
      inputDir: workDir,
      prefix: 'mix',
      targetSizeMb: 2,
      force: true,
    });

    expect(summary.outputs).toHaveLength(1);
    expect(summary.outputs[0]!.name).toBe('mix-0001.pdf');
    const skippedNames = summary.skipped.map((s) => s.name).sort();
    expect(skippedNames).toEqual(['cover.jpg', 'notes.txt']);
  });
});
