import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { prepareForKindle } from '../../src/index.js';
import { makeRandomGrayscalePng } from '../helpers/image-encoders.js';

async function writeFileEnsured(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

describe('integration: tree mode', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sk-tree-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function addChapter(rel: string, pages: number, size = 40): Promise<void> {
    for (let i = 1; i <= pages; i += 1) {
      const png = makeRandomGrayscalePng(size, size);
      await writeFileEnsured(join(root, rel, `${i}.png`), png);
    }
  }

  it('processes a JJK-like layout: volumes first, then standalone chapters', async () => {
    await addChapter('Volume 01/capitolo-01', 3);
    await addChapter('Volume 01/capitolo-02', 3);
    await addChapter('Volume 02/capitolo-08', 3);
    await addChapter('Capitolo 168', 2);
    await addChapter('Capitolo 168.5', 2);
    await addChapter('Capitolo 169', 2);

    const { summary, plan } = await prepareForKindle({
      inputDir: root,
      prefix: 'jjk',
      targetSizeMb: 2,
      force: true,
    });

    expect(summary.mode).toBe('tree');
    expect(summary.outputs.length).toBeGreaterThanOrEqual(1);
    if (summary.stagingDir) {
      const { stat } = await import('node:fs/promises');
      await expect(stat(summary.stagingDir)).rejects.toThrow();
    }

    const firstSource = plan[0]!.sources[0]!;
    expect(firstSource).toMatch(/Volume_01/);

    const lastSource = plan[plan.length - 1]!.sources.at(-1)!;
    expect(lastSource).toMatch(/Capitolo_169/);
  });

  it('cleans up the staging directory after a successful run', async () => {
    await addChapter('Vol A/ch 1', 2);

    let observedStagingDir: string | undefined;
    await prepareForKindle({
      inputDir: root,
      prefix: 'j',
      targetSizeMb: 2,
      force: true,
      dryRun: true,
      onProgress: (evt) => {
        if (evt.step === 'stage' && evt.index === 1) {
          // just observe, no-op
        }
      },
    });

    const { summary } = await prepareForKindle({
      inputDir: root,
      prefix: 'j',
      targetSizeMb: 2,
      force: true,
    });

    observedStagingDir = summary.stagingDir;
    if (observedStagingDir !== undefined) {
      const path: string = observedStagingDir;
      await expect(import('node:fs/promises').then((fs) => fs.stat(path))).rejects.toThrow();
    }
  });

  it('keeps the staging directory when --keep-staging is set', async () => {
    await addChapter('Vol A/ch 1', 2);
    const { summary } = await prepareForKindle({
      inputDir: root,
      prefix: 'j',
      targetSizeMb: 2,
      force: true,
      keepStaging: true,
    });
    expect(summary.stagingDir).toBeDefined();
    const { stat } = await import('node:fs/promises');
    const s = await stat(summary.stagingDir!);
    expect(s.isDirectory()).toBe(true);
    await rm(summary.stagingDir!, { recursive: true, force: true });
  });

  it('output PDF pages are sized to source image pixels (1:1)', async () => {
    await writeFileEnsured(join(root, 'Cap 1', '1.png'), makeRandomGrayscalePng(80, 120));
    await writeFileEnsured(join(root, 'Cap 1', '2.png'), makeRandomGrayscalePng(64, 64));

    const { summary } = await prepareForKindle({
      inputDir: root,
      prefix: 'px',
      targetSizeMb: 2,
      force: true,
    });

    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(join(root, 'output', summary.outputs[0]!.name));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPage(0).getWidth()).toBe(80);
    expect(doc.getPage(0).getHeight()).toBe(120);
    expect(doc.getPage(1).getWidth()).toBe(64);
    expect(doc.getPage(1).getHeight()).toBe(64);
  });
});
