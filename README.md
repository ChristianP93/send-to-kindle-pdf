# send-to-kindle-pdf

> Prepare PDFs for Amazon **Send to Kindle**: auto-merge small files and split large ones under the 200 MB limit while preserving source order.

Amazon Send to Kindle rejects PDFs larger than 200 MB. Manga libraries and multi-volume books are often either too small (hundreds of tiny chapter files) or too large (single 400 MB scans). `send-to-kindle-pdf` pre-processes a folder of PDFs (or image folders) into a sequence of Kindle-ready files:

- **Merges** consecutive small files up to a conservative 180 MB target.
- **Splits** files larger than the target at page boundaries — never in the middle of a page.
- **Preserves** source order (critical for chaptered content).
- **Re-uses** the residue of a split as the start of the next chunk.
- **Accepts image folders** (`.jpg`, `.png`): chapters stored as sequences of
  page images are auto-converted to PDFs before packing (lossless, 1:1).

## Install

```bash
# global
npm install -g send-to-kindle-pdf

# one-shot
npx send-to-kindle-pdf <folder> <prefix>
```

Requires Node.js **≥ 20**.

## CLI usage

```bash
send-to-kindle-pdf <folder> <prefix> [options]
```

| Argument | Description |
|---|---|
| `folder` | Directory containing source PDFs (non-recursive). |
| `prefix` | Output filename prefix — must match `[A-Za-z0-9_-]+`. |

### Options

| Flag | Default | Description |
|---|---|---|
| `--target-size <mb>` | `180` | Target size in MB. Must be `≥ 1` and `< 200`. |
| `--output-dir <name>` | `output` | Output directory, created inside `<folder>`. |
| `--padding <n>` | `4` | Zero-padding width for the counter. Max counter = `10^n − 1`. |
| `--force` | `false` | Delete and recreate the output directory if it exists. |
| `--dry-run` | `false` | Print the plan without writing files. |
| `--mode <mode>` | `auto` | Discovery mode: `auto`, `flat`, or `tree`. |
| `--keep-staging` | `false` | Keep the temp staging directory (debug; tree / normalize modes). |
| `--normalize` | `false` | Pre-process every source PDF through Ghostscript (see below). |
| `--verbose` | `false` | Extra debug logging on stderr. |
| `-v, --version` | | Print version. |
| `-h, --help` | | Print help. |

Output files land in `<folder>/<output-dir>/` with the pattern `<prefix>-NNNN.pdf`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Runtime error (missing folder, no PDFs, I/O failure, counter overflow, output dir exists without `--force`) |
| `2` | Invalid arguments |

### Example

```bash
send-to-kindle-pdf ~/manga/one-piece one-piece
# → ~/manga/one-piece/output/one-piece-0001.pdf
# → ~/manga/one-piece/output/one-piece-0002.pdf
# → ...
```

## Programmatic API

```ts
import { prepareForKindle } from 'send-to-kindle-pdf';

const { summary, plan } = await prepareForKindle({
  inputDir: '/path/to/manga',
  prefix: 'one-piece',
  targetSizeMb: 180,         // optional, default 180
  outputDir: 'output',       // optional, default 'output'
  padding: 4,                // optional, default 4
  force: false,              // optional, default false
  dryRun: false,             // optional, default false
  onProgress: (evt) => {
    switch (evt.step) {
      case 'discovery':
        console.log(`Found ${evt.files} PDFs`);
        break;
      case 'plan':
        console.log(`Planning ${evt.chunks} output files`);
        break;
      case 'write':
        console.log(`Writing ${evt.index}/${evt.total}: ${evt.filename}`);
        break;
      case 'done':
        console.log(`Done, produced ${evt.outputs.length} files`);
        break;
    }
  },
});

console.log(summary);
```

### `ProgressEvent`

```ts
type ProgressEvent =
  | { step: 'discovery'; files: number }
  | { step: 'plan'; chunks: number }
  | { step: 'write'; index: number; total: number; filename: string }
  | { step: 'done'; outputs: readonly string[] };
```

## Folder mode & supported layouts

`send-to-kindle-pdf` operates in one of two modes, selected automatically by
inspecting `<folder>`:

### Flat mode (default when root has PDFs)

```
my-book/
├── chapter-01.pdf
├── chapter-02.pdf
└── chapter-03.pdf
```

All `.pdf` files at the top level are processed in natural order. This is the
v0.1 behaviour.

### Tree mode (default when root has subfolders)

Each **leaf folder** (a directory with no subdirectories) becomes one *input
unit*. Leaf folders can contain:

- Images (`.jpg`, `.jpeg`, `.png`) → each becomes one PDF page at 1:1 pixel
  size (lossless — JPEG bytes embedded as-is, PNG decoded and re-encoded by
  `pdf-lib` without re-compression);
- `.pdf` files → concatenated in natural order after the images.

Nested structures (volumes containing chapters, etc.) are supported to
arbitrary depth.

#### Ordering rules

At each directory level:

1. **Branch folders** (those that contain subdirectories) are traversed
   before **leaf folders** at the same level — so volume directories come
   before standalone chapter directories.
2. Within each category (branches vs leaves vs files), natural-sort on the
   folder/file name (`cap-2` before `cap-10`).
3. Root-level `.pdf` files come **after** all subdirectory leaves.

#### Example: multi-volume library

```
your-book/
├── your-book - Volume 01/        ← branch: traversed first
│   ├── chapter-01-<hash>/        ← leaf: unit #1
│   │   ├── 1.jpg
│   │   └── 2.png
│   └── chapter-02-<hash>/        ← unit #2
├── your-book - Volume 02/
│   └── chapter-08-<hash>/        ← unit #N
├── your-book  Chapter 168/       ← leaf at root: after all volumes
│   └── 1.jpg
├── your-book  Chapter 168.5/
└── your-book  Chapter 169/
```

Run:

```bash
send-to-kindle-pdf "/path/to/your-book" your-book
```

produces `your-book-0001.pdf`, `your-book-0002.pdf`, … packed under the 180 MB target.

#### Staging

In tree mode each unit is first written as an intermediate PDF in
`$TMPDIR/skp-stage-*/`; the existing pack/split pipeline then runs on that
temp directory. The temp directory is removed at the end of the run (use
`--keep-staging` to inspect it during debugging).

#### Skipped content

- Non-image, non-PDF files → warning, ignored.
- Files inside folders that also contain subdirectories (non-leaf) →
  warning, ignored (except root-level PDFs).
- Corrupt images or unsupported formats (`.webp`, `.tiff`, `.gif`) →
  warning, the rest of the leaf is processed normally.
- Empty leaf folders → warning, ignored.
- **Symbolic links** (files or directories) → warning, ignored. The tool
  never follows symlinks, both as a safety boundary against escaping the
  input directory and to keep behaviour predictable.
- **Individual PDFs larger than 1 GB** → warning, ignored (the rest of the
  batch is processed). Anything that big is unlikely to be a Send to Kindle
  candidate anyway.

#### Hard limits

To avoid runaway scans on pathological inputs, discovery aborts with an
error if the directory tree is deeper than **32 levels**, or if it contains
more than **50 000** files in scope.

## Normalizing bloated source PDFs (`--normalize`)

Some scanned libraries (notably Manga Edge releases) ship PDFs with large
resources — image XObjects, embedded fonts — stored at document level and
shared across every page. `pdf-lib` (the underlying PDF engine) duplicates
those document-level resources into the destination whenever it extracts
pages. The result: a 300 MB source becomes ~300 MB *per extracted page*, and
the packer produces dozens of single-page outputs each over the 200 MB limit.

If you see warnings like:

```
[size] file.pdf: single page 302539004 bytes exceeds target 188743680 — emitting anyway.
```

…re-run with `--normalize`. Every source PDF is first re-processed through
Ghostscript (`-dPDFSETTINGS=/ebook`, images rasterised at 150 dpi) into a
temp directory; the normal packing pipeline then runs on those normalised
copies.

### Requirements

Ghostscript must be on `PATH`:

- macOS: `brew install ghostscript`
- Debian/Ubuntu: `sudo apt install ghostscript`
- Windows: [ghostscript.com/releases](https://ghostscript.com/releases/) (looked up as `gswin64c.exe` / `gswin32c.exe`)

### Trade-offs

- **Slow**: Ghostscript is CPU-bound single-threaded; the tool runs up to 4
  workers in parallel but a 2.5 GB library still takes several minutes.
- **Lossy**: images are downsampled to 150 dpi. This is above the effective
  display density of a 6″ Kindle, so quality loss is imperceptible for
  manga/comics. If you need pixel-perfect output, don't pass `--normalize` —
  but you'll only hit the bloat issue on sources that already need it.
- **Applies to every source**: there is no per-file opt-in. For
  tree-mode libraries built from images this is a near-no-op and safe.

### Example

```bash
send-to-kindle-pdf ~/Downloads/witch-hat-atelier witch-hat --normalize
```

## Algorithm

Single-pass greedy in natural filename order:

- If a source file is **larger than the target**, it is flushed to its own chunks at page boundaries. The final residual segment becomes the current buffer so that subsequent small files can still merge with it.
- If a source file is **smaller than or equal to the target**, it is appended whole to the current buffer. If it does not fit, the buffer is flushed first and the file starts a new buffer. Files at or under the target are **never** split across two output chunks — chapter integrity is preserved.

No page is ever split across two chunks. Consequently every output is `≤ target`, except for the pathological case of a single page that alone exceeds the target (a warning is emitted and the page is written as-is).

## FAQ

**Why 180 MB and not 200 MB?** Send to Kindle rejects files at exactly 200 MB and is occasionally fussy near the limit. 180 MB leaves a 10% safety margin; change it with `--target-size` if you want to push closer.

**Does it re-compress images or alter page content?** No. PDF pages are
copied verbatim via `pdf-lib`. Images are embedded losslessly: JPEG bytes are
stored as-is, PNG pixels are decoded and re-encoded by `pdf-lib` without any
lossy step.

**Will it recurse into subfolders?** Yes, since v0.2 — see the *Folder mode
& supported layouts* section.

**My pages are huge (4000×6000 px). Is that a problem?** No. The output PDF
pages match the image pixel dimensions (1:1). Kindle devices and the Send
to Kindle service render pages fit-to-screen, so the physical page size
doesn't affect display quality.

**What about PDF bookmarks/outline?** v0.2 does not preserve outline.
Planned for a future minor.

## License

MIT © Christian Pengu
