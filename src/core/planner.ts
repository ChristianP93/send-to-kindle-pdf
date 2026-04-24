import type { PlanEntry, SourcePageRef } from '../types.js';

export interface PlannerSource {
  readonly name: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly pageCount: number;
}

export interface PlannerOptions {
  readonly sources: readonly PlannerSource[];
  readonly targetBytes: number;
  readonly nameFor: (outputIndex: number) => string;
}

interface ChunkBuffer {
  pages: SourcePageRef[];
  bytes: number;
  sources: Set<string>;
}

function emptyChunk(): ChunkBuffer {
  return { pages: [], bytes: 0, sources: new Set() };
}

function flush(
  buffer: ChunkBuffer,
  plan: PlanEntry[],
  nameFor: (i: number) => string,
): ChunkBuffer {
  if (buffer.pages.length === 0) return buffer;
  const outputIndex = plan.length + 1;
  plan.push({
    outputIndex,
    outputName: nameFor(outputIndex),
    pages: buffer.pages,
    estimatedBytes: Math.round(buffer.bytes),
    sources: [...buffer.sources],
  });
  return emptyChunk();
}

function pageRef(source: PlannerSource, pageIndex: number): SourcePageRef {
  return {
    sourcePath: source.absolutePath,
    sourceName: source.name,
    pageIndex,
  };
}

export function planChunks(options: PlannerOptions): PlanEntry[] {
  const { sources, targetBytes, nameFor } = options;
  const plan: PlanEntry[] = [];
  let buffer = emptyChunk();

  for (const source of sources) {
    if (source.pageCount <= 0) continue;

    const avgBytesPerPage = source.size / source.pageCount;

    if (source.size > targetBytes) {
      buffer = flush(buffer, plan, nameFor);

      // Floor would be 0 if a single page already exceeds the target — clamp to 1
      // so we still make forward progress; sizer.ts handles the over-target emit.
      const pagesPerFullSegment = Math.max(1, Math.floor(targetBytes / avgBytesPerPage));
      let pageIndex = 0;

      while (source.pageCount - pageIndex > pagesPerFullSegment) {
        const segmentPages: SourcePageRef[] = [];
        for (let i = 0; i < pagesPerFullSegment; i += 1) {
          segmentPages.push(pageRef(source, pageIndex + i));
        }
        pageIndex += pagesPerFullSegment;
        const segmentChunk: ChunkBuffer = {
          pages: segmentPages,
          bytes: segmentPages.length * avgBytesPerPage,
          sources: new Set([source.name]),
        };
        buffer = flush(segmentChunk, plan, nameFor);
      }

      // The trailing segment of an oversized split is intentionally NOT flushed:
      // it becomes the running buffer so the next small source can merge into
      // it, reusing the residue and avoiding a near-empty output chunk.
      for (let i = pageIndex; i < source.pageCount; i += 1) {
        buffer.pages.push(pageRef(source, i));
      }
      buffer.bytes = buffer.pages.length * avgBytesPerPage;
      buffer.sources.add(source.name);
      continue;
    }

    // Files at or under the target are atomic: if the whole file does not
    // fit in the current buffer we flush and start a new one, but we never
    // split a small file across two outputs (chapter integrity).
    if (buffer.bytes + source.size > targetBytes) {
      buffer = flush(buffer, plan, nameFor);
    }

    for (let i = 0; i < source.pageCount; i += 1) {
      buffer.pages.push(pageRef(source, i));
    }
    buffer.bytes += source.size;
    buffer.sources.add(source.name);
  }

  flush(buffer, plan, nameFor);
  return plan;
}
