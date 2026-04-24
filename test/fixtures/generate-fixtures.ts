import { randomBytes, createHash } from 'node:crypto';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';

const KB = 1024;

export interface FixtureSpec {
  readonly name: string;
  readonly pageCount: number;
  readonly bytesPerPage: number;
}

// Scaled fixtures: we target ~500 KB / file as the natural integration "big"
// size, so tests can use --target-size 1 MB without needing 200 MB of fixtures.
export const FIXTURE_SPECS: readonly FixtureSpec[] = [
  { name: 'tiny.pdf', pageCount: 10, bytesPerPage: 20 * KB },
  { name: 'medium.pdf', pageCount: 80, bytesPerPage: 20 * KB },
  { name: 'huge.pdf', pageCount: 200, bytesPerPage: 20 * KB },
  { name: 'single-page-huge.pdf', pageCount: 1, bytesPerPage: 1200 * KB },
];

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'generated');
export const MANIFEST_PATH = join(FIXTURE_DIR, '.manifest.json');

interface Manifest {
  readonly version: number;
  readonly specsHash: string;
  readonly files: Record<string, { readonly bytes: number }>;
}

function hashSpecs(specs: readonly FixtureSpec[]): string {
  const data = JSON.stringify(specs);
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

let crc32Table: Uint32Array | undefined;
function getCrc32Table(): Uint32Array {
  if (crc32Table) return crc32Table;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crc32Table = t;
  return t;
}

function crc32(data: Uint8Array): number {
  const table = getCrc32Table();
  let crc = 0xffffffff;
  for (const b of data) crc = ((crc >>> 8) ^ table[(crc ^ b) & 0xff]!) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function makeRandomGrayscalePng(width: number, height: number): Uint8Array {
  const rowBytes = width + 1;
  const raw = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0;
    const row = randomBytes(width);
    raw.set(row, y * rowBytes + 1);
  }
  const compressed = deflateSync(Buffer.from(raw), { level: 0 });

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function dimensionForBytes(bytesPerPage: number): { width: number; height: number } {
  const pixels = Math.max(64, bytesPerPage - 64);
  const side = Math.max(8, Math.ceil(Math.sqrt(pixels)));
  return { width: side, height: side };
}

async function generateFixture(spec: FixtureSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const dims = dimensionForBytes(spec.bytesPerPage);

  for (let i = 0; i < spec.pageCount; i += 1) {
    const pngBytes = makeRandomGrayscalePng(dims.width, dims.height);
    const image = await doc.embedPng(pngBytes);
    const page = doc.addPage([612, 792]);
    page.drawImage(image, { x: 10, y: 10, width: 50, height: 50 });
  }

  return doc.save({ useObjectStreams: false });
}

export async function ensureFixtures(): Promise<{
  readonly dir: string;
  readonly regenerated: boolean;
}> {
  await mkdir(FIXTURE_DIR, { recursive: true });

  const expectedHash = hashSpecs(FIXTURE_SPECS);
  let manifest: Manifest | undefined;
  if (await fileExists(MANIFEST_PATH)) {
    try {
      const raw = await readFile(MANIFEST_PATH, 'utf8');
      manifest = JSON.parse(raw) as Manifest;
    } catch {
      manifest = undefined;
    }
  }

  const allPresent =
    manifest?.specsHash === expectedHash &&
    (await Promise.all(FIXTURE_SPECS.map((s) => fileExists(join(FIXTURE_DIR, s.name))))).every(
      Boolean,
    );

  if (allPresent) {
    return { dir: FIXTURE_DIR, regenerated: false };
  }

  const files: Record<string, { bytes: number }> = {};
  for (const spec of FIXTURE_SPECS) {
    const bytes = await generateFixture(spec);
    const outPath = join(FIXTURE_DIR, spec.name);
    await writeFile(outPath, bytes);
    files[spec.name] = { bytes: bytes.byteLength };
  }

  const newManifest: Manifest = {
    version: 1,
    specsHash: expectedHash,
    files,
  };
  await writeFile(MANIFEST_PATH, JSON.stringify(newManifest, null, 2));

  return { dir: FIXTURE_DIR, regenerated: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureFixtures()
    .then((r) => {
      process.stdout.write(`Fixtures ready in ${r.dir} (regenerated: ${String(r.regenerated)})\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(`fixture generation failed: ${String(err)}\n`);
      process.exit(1);
    });
}
