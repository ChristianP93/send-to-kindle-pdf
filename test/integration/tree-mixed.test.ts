import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prepareForKindle } from '../../src/index.js';
import { ensureFixtures, FIXTURE_DIR } from '../fixtures/generate-fixtures.js';
import { makeRandomGrayscalePng } from '../helpers/image-encoders.js';

async function writeFileEnsured(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

describe('integration: tree mode with mixed root (subdirs + pdf files)', () => {
  let root: string;

  beforeAll(async () => {
    await ensureFixtures();
  }, 600_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sk-mixroot-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('places root-level pdf files after all subdir leaves', async () => {
    for (let i = 1; i <= 2; i += 1) {
      await writeFileEnsured(
        join(root, 'Volume 01', 'cap-01', `${i}.png`),
        makeRandomGrayscalePng(24, 24),
      );
    }
    await writeFileEnsured(join(root, 'Capitolo 200', '1.png'), makeRandomGrayscalePng(24, 24));

    await copyFile(join(FIXTURE_DIR, 'tiny.pdf'), join(root, 'extra.pdf'));

    const { plan } = await prepareForKindle({
      inputDir: root,
      prefix: 'mx',
      targetSizeMb: 2,
      force: true,
    });

    const sourcesFlat = plan.flatMap((p) => p.sources);

    const volumeIdx = sourcesFlat.findIndex((s) => s.includes('cap-01'));
    const chapterIdx = sourcesFlat.findIndex((s) => s.includes('Capitolo_200'));
    const extraIdx = sourcesFlat.findIndex((s) => s.includes('extra'));

    expect(volumeIdx).toBeGreaterThanOrEqual(0);
    expect(chapterIdx).toBeGreaterThanOrEqual(0);
    expect(extraIdx).toBeGreaterThanOrEqual(0);

    expect(volumeIdx).toBeLessThan(chapterIdx);
    expect(chapterIdx).toBeLessThan(extraIdx);
  });
});
