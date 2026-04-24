import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';

describe('integration: output PDF metadata', () => {
  let workDir: string;

  beforeAll(async () => {
    await ensureFixtures();
  }, 600_000);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sk-meta-'));
    await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(workDir, 'a.pdf'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('sets the PDF title to the output filename (without extension)', async () => {
    await prepareForKindle({
      inputDir: workDir,
      prefix: 'meta',
      targetSizeMb: 2,
      force: true,
    });

    const outBytes = await readFile(join(workDir, 'output', 'meta-0001.pdf'));
    const doc = await PDFDocument.load(outBytes);
    expect(doc.getTitle()).toBe('meta-0001');
    expect(doc.getCreator()).toBe('send-to-kindle-pdf');
  });
});
