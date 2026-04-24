import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';

const MB = 1024 * 1024;
const TARGET_MB = 2;

describe('integration: small files merge', () => {
  let workDir: string;

  beforeAll(async () => {
    await ensureFixtures();
  }, 600_000);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sk-small-'));
    for (let i = 1; i <= 5; i += 1) {
      await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(workDir, `cap-0${i}.pdf`));
    }
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('merges 5 tiny files into a single output ≤ target', async () => {
    const { summary } = await prepareForKindle({
      inputDir: workDir,
      prefix: 'manga',
      targetSizeMb: TARGET_MB,
      force: true,
    });

    expect(summary.outputs).toHaveLength(1);
    expect(summary.outputs[0]!.name).toBe('manga-0001.pdf');

    const outPath = join(workDir, 'output', 'manga-0001.pdf');
    const s = await stat(outPath);
    expect(s.size).toBeLessThanOrEqual(TARGET_MB * MB);
    expect(s.size).toBe(summary.outputs[0]!.bytes);
  });
});
