import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';

const MB = 1024 * 1024;
const TARGET_MB = 1;

describe('integration: split residue merges with subsequent files', () => {
  let workDir: string;

  beforeAll(async () => {
    await ensureFixtures();
  }, 600_000);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sk-residue-'));
    await copyFile(join(FIXTURE_DIR, 'huge.pdf'), join(workDir, '1-volume.pdf'));
    for (let i = 1; i <= 5; i += 1) {
      await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(workDir, `2-cap-0${i}.pdf`));
    }
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('packs the residue of a split together with following small files', async () => {
    const { plan, summary } = await prepareForKindle({
      inputDir: workDir,
      prefix: 'r',
      targetSizeMb: TARGET_MB,
      force: true,
    });

    for (const out of summary.outputs) {
      expect(out.bytes).toBeLessThanOrEqual(TARGET_MB * MB);
    }

    const chunkMergingVolumeAndTiny = plan.find(
      (p) => p.sources.some((s) => s.startsWith('1-')) && p.sources.some((s) => s.startsWith('2-')),
    );
    expect(chunkMergingVolumeAndTiny).toBeDefined();
  });
});
