import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';

describe('integration: natural sort ordering', () => {
  let workDir: string;

  beforeAll(async () => {
    await ensureFixtures();
  }, 600_000);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sk-sort-'));
    for (const name of ['cap-2.pdf', 'cap-102.pdf', 'cap-1.pdf', 'cap-10.pdf']) {
      await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(workDir, name));
    }
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('merges chapters respecting natural order 1 < 2 < 10 < 102', async () => {
    const { plan } = await prepareForKindle({
      inputDir: workDir,
      prefix: 'nat',
      targetSizeMb: 2,
      force: true,
    });

    const first = plan[0];
    expect(first).toBeDefined();
    expect(first!.sources).toEqual(['cap-1.pdf', 'cap-2.pdf', 'cap-10.pdf', 'cap-102.pdf']);
  });
});
