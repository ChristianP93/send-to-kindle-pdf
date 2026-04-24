import { PDFDocument } from 'pdf-lib';

import type { Logger } from '../logger.js';
import type { SourcePageRef } from '../types.js';

export interface SourceCache {
  load(absolutePath: string): Promise<PDFDocument>;
  clear(): void;
}

export function createSourceCache(loadBytes: (path: string) => Promise<Uint8Array>): SourceCache {
  const docs = new Map<string, Promise<PDFDocument>>();
  return {
    async load(absolutePath: string): Promise<PDFDocument> {
      let entry = docs.get(absolutePath);
      if (!entry) {
        entry = (async () => {
          const bytes = await loadBytes(absolutePath);
          return PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
        })();
        docs.set(absolutePath, entry);
      }
      return entry;
    },
    clear(): void {
      docs.clear();
    },
  };
}

export interface AssembleResult {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
}

export interface AssembleOptions {
  readonly title?: string;
}

export async function assemblePages(
  pages: readonly SourcePageRef[],
  cache: SourceCache,
  options: AssembleOptions = {},
): Promise<AssembleResult> {
  if (pages.length === 0) {
    throw new Error('assemblePages called with empty page list');
  }

  const output = await PDFDocument.create();
  if (options.title !== undefined) {
    output.setTitle(options.title);
  }
  output.setCreator('send-to-kindle-pdf');

  // Pages from the same source are batched into one copyPages() call: pdf-lib
  // deduplicates shared resources (fonts, image XObjects) within a single
  // batch, so a chapter copied as one group is dramatically smaller than the
  // same pages copied one-by-one.
  const grouped = groupConsecutive(pages);
  for (const group of grouped) {
    const source = await cache.load(group.sourcePath);
    const copied = await output.copyPages(source, group.pageIndexes);
    for (const page of copied) {
      output.addPage(page);
    }
  }

  const bytes = await output.save({ useObjectStreams: true });
  return { bytes, pageCount: pages.length };
}

interface PageGroup {
  readonly sourcePath: string;
  readonly pageIndexes: number[];
}

function groupConsecutive(pages: readonly SourcePageRef[]): PageGroup[] {
  const groups: PageGroup[] = [];
  for (const page of pages) {
    const last = groups[groups.length - 1];
    if (last?.sourcePath === page.sourcePath) {
      last.pageIndexes.push(page.pageIndex);
    } else {
      groups.push({ sourcePath: page.sourcePath, pageIndexes: [page.pageIndex] });
    }
  }
  return groups;
}

export interface FitResult {
  readonly bytes: Uint8Array;
  readonly pages: readonly SourcePageRef[];
  readonly overflow: readonly SourcePageRef[];
}

export interface FitOptions {
  readonly pages: readonly SourcePageRef[];
  readonly targetBytes: number;
  readonly cache: SourceCache;
  readonly logger: Logger;
  readonly chunkLabel: string;
  readonly title?: string;
}

/**
 * Serialize `pages` into a PDF and shrink from the tail until it fits under
 * `targetBytes`. Returns the dropped tail as `overflow` so the caller can
 * prepend it to the next chunk — this is what guarantees no page is lost
 * across a split.
 *
 * We re-serialize on each attempt instead of computing the cut upfront because
 * pdf-lib does not expose a serialized size before `save()`: image streams,
 * object compression and shared resources make per-page bytes non-additive.
 */
export async function fitPagesToTarget(options: FitOptions): Promise<FitResult> {
  const { pages, targetBytes, cache, logger, chunkLabel, title } = options;

  if (pages.length === 0) {
    throw new Error('fitPagesToTarget called with empty page list');
  }

  let currentPages: SourcePageRef[] = [...pages];
  let attempt = 0;

  while (currentPages.length > 0) {
    attempt += 1;
    const { bytes } = await assemblePages(
      currentPages,
      cache,
      title === undefined ? {} : { title },
    );

    if (bytes.byteLength <= targetBytes) {
      const overflow = pages.slice(currentPages.length);
      logger.debug(
        `[sizer] ${chunkLabel}: attempt ${attempt}, ${currentPages.length}/${pages.length} pages, ` +
          `${bytes.byteLength} bytes (target ${targetBytes}).`,
      );
      return { bytes, pages: currentPages, overflow };
    }

    // A single page that already exceeds the target cannot be shrunk without
    // re-encoding (lossy). Spec §3.3 mandates emitting it as-is with a warning
    // rather than silently dropping it or refusing to make progress.
    if (currentPages.length === 1) {
      logger.warn(
        `[size] ${chunkLabel}: single page ${bytes.byteLength} bytes exceeds target ${targetBytes} — emitting anyway.`,
      );
      return { bytes, pages: currentPages, overflow: pages.slice(1) };
    }

    // Linear backoff proportional to the overshoot. This converges quickly in
    // practice (1–3 attempts) because PDF size is roughly linear in page count
    // once shared resources are amortized; binary search is overkill at v1.
    const overshoot = bytes.byteLength - targetBytes;
    const avg = bytes.byteLength / currentPages.length;
    const pagesToDrop = Math.max(1, Math.ceil(overshoot / avg));
    const newLength = Math.max(1, currentPages.length - pagesToDrop);
    currentPages = currentPages.slice(0, newLength);
  }

  // Unreachable: the loop only exits via return. Kept as a typed safety net.
  throw new Error(`fitPagesToTarget: unable to fit ${chunkLabel} under ${targetBytes} bytes`);
}
