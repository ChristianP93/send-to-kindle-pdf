import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';

const MB = 1024 * 1024;
const TARGET_MB = 1;

describe('integration: large file splitting', () => {
  let workDir: string;
  let sourceSize: number;

  beforeAll(async () => {
    await ensureFixtures();
    const s = await stat(join(FIXTURE_DIR, 'huge.pdf'));
    sourceSize = s.size;
  }, 600_000);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sk-big-'));
    await copyFile(join(FIXTURE_DIR, 'huge.pdf'), join(workDir, 'volume.pdf'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('splits a single big file into multiple outputs, each ≤ target', async () => {
    const { summary } = await prepareForKindle({
      inputDir: workDir,
      prefix: 'vol',
      targetSizeMb: TARGET_MB,
      force: true,
    });

    expect(summary.outputs.length).toBeGreaterThanOrEqual(2);
    for (const out of summary.outputs) {
      expect(out.bytes).toBeLessThanOrEqual(TARGET_MB * MB);
    }
    const totalBytes = summary.outputs.reduce((acc, o) => acc + o.bytes, 0);
    expect(totalBytes).toBeGreaterThan(sourceSize * 0.5);
  });
});
