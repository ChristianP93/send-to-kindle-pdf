import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';

describe('integration: dry run', () => {
  let workDir: string;

  beforeAll(async () => {
    await ensureFixtures();
  }, 600_000);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sk-dry-'));
    await copyFile(join(FIXTURE_DIR, 'huge.pdf'), join(workDir, 'volume.pdf'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('produces a plan without writing any output files', async () => {
    const { plan } = await prepareForKindle({
      inputDir: workDir,
      prefix: 'dry',
      targetSizeMb: 1,
      dryRun: true,
    });

    expect(plan.length).toBeGreaterThan(0);
    const entries = await readdir(workDir);
    expect(entries).toEqual(['volume.pdf']);
  });
});
