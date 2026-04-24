import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';

const MB = 1024 * 1024;
const TARGET_MB = 1;

describe('integration: mixed scenario (5×tiny + 1×huge)', () => {
  let workDir: string;

  beforeAll(async () => {
    await ensureFixtures();
  }, 600_000);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sk-mixed-'));
    for (let i = 1; i <= 5; i += 1) {
      await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(workDir, `a-0${i}.pdf`));
    }
    await copyFile(join(FIXTURE_DIR, 'huge.pdf'), join(workDir, 'b-volume.pdf'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('merges small files first, then splits the big one', async () => {
    const { summary } = await prepareForKindle({
      inputDir: workDir,
      prefix: 'm',
      targetSizeMb: TARGET_MB,
      force: true,
    });

    expect(summary.outputs.length).toBeGreaterThanOrEqual(3);
    for (const out of summary.outputs) {
      expect(out.bytes).toBeLessThanOrEqual(TARGET_MB * MB);
    }
  });
});
