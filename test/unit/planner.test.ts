import { describe, expect, it } from 'vitest';

import { planChunks, type PlannerSource } from '../../src/core/planner.js';

const MB = 1024 * 1024;

function source(name: string, sizeMb: number, pageCount: number): PlannerSource {
  return { name, absolutePath: `/virtual/${name}`, size: Math.floor(sizeMb * MB), pageCount };
}

const nameFor = (i: number): string => `out-${String(i).padStart(4, '0')}.pdf`;

describe('planChunks', () => {
  const targetBytes = 180 * MB;

  it('produces one output when multiple small files fit together', () => {
    const plan = planChunks({
      sources: [
        source('a.pdf', 10, 50),
        source('b.pdf', 10, 50),
        source('c.pdf', 10, 50),
        source('d.pdf', 10, 50),
        source('e.pdf', 10, 50),
      ],
      targetBytes,
      nameFor,
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]!.pages).toHaveLength(250);
    expect(plan[0]!.sources).toEqual(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf']);
    expect(plan[0]!.outputName).toBe('out-0001.pdf');
  });

  it('splits a large file greedily and keeps the residue as current chunk', () => {
    const plan = planChunks({
      sources: [source('big.pdf', 400, 800)],
      targetBytes,
      nameFor,
    });

    expect(plan).toHaveLength(3);
    const totalPages = plan.reduce((acc, p) => acc + p.pages.length, 0);
    expect(totalPages).toBe(800);

    for (const entry of plan) {
      expect(entry.estimatedBytes).toBeLessThanOrEqual(targetBytes);
    }

    const last = plan[plan.length - 1]!;
    expect(last.estimatedBytes).toBeLessThan(targetBytes);
  });

  it('merges the split-residue with subsequent small files', () => {
    const plan = planChunks({
      sources: [
        source('big.pdf', 400, 800),
        source('t1.pdf', 10, 50),
        source('t2.pdf', 10, 50),
        source('t3.pdf', 10, 50),
        source('t4.pdf', 10, 50),
        source('t5.pdf', 10, 50),
      ],
      targetBytes,
      nameFor,
    });

    const bigOnlyChunks = plan.filter((p) => p.sources.length === 1 && p.sources[0] === 'big.pdf');
    expect(bigOnlyChunks).toHaveLength(2);

    const merged = plan.find((p) => p.sources.includes('big.pdf') && p.sources.length > 1);
    expect(merged).toBeDefined();
    expect(merged!.sources).toEqual(['big.pdf', 't1.pdf', 't2.pdf', 't3.pdf', 't4.pdf', 't5.pdf']);
  });

  it('flushes current chunk before starting a splitting file', () => {
    const plan = planChunks({
      sources: [source('a.pdf', 50, 100), source('big.pdf', 400, 800)],
      targetBytes,
      nameFor,
    });

    expect(plan[0]!.sources).toEqual(['a.pdf']);
    expect(plan[0]!.pages).toHaveLength(100);
    for (let i = 1; i < plan.length; i += 1) {
      expect(plan[i]!.sources).toContain('big.pdf');
      expect(plan[i]!.sources).not.toContain('a.pdf');
    }
  });

  it('never splits a file ≤ target across chunks (chapter integrity)', () => {
    const plan = planChunks({
      sources: [source('a.pdf', 100, 200), source('b.pdf', 100, 200)],
      targetBytes,
      nameFor,
    });

    expect(plan).toHaveLength(2);
    expect(plan[0]!.sources).toEqual(['a.pdf']);
    expect(plan[0]!.pages).toHaveLength(200);
    expect(plan[1]!.sources).toEqual(['b.pdf']);
    expect(plan[1]!.pages).toHaveLength(200);
  });

  it('assigns sequential output indexes and names', () => {
    const plan = planChunks({
      sources: [source('a.pdf', 100, 100), source('b.pdf', 100, 100), source('c.pdf', 100, 100)],
      targetBytes,
      nameFor,
    });

    expect(plan.map((p) => p.outputIndex)).toEqual([1, 2, 3]);
    expect(plan.map((p) => p.outputName)).toEqual(['out-0001.pdf', 'out-0002.pdf', 'out-0003.pdf']);
  });

  it('ignores sources with zero pages', () => {
    const plan = planChunks({
      sources: [source('empty.pdf', 0, 0), source('a.pdf', 10, 50)],
      targetBytes,
      nameFor,
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]!.sources).toEqual(['a.pdf']);
  });

  it('handles pathological single-page-over-target source (1 page per chunk)', () => {
    const plan = planChunks({
      sources: [source('huge-page.pdf', 500, 2)],
      targetBytes,
      nameFor,
    });
    const totalPages = plan.reduce((acc, p) => acc + p.pages.length, 0);
    expect(totalPages).toBe(2);
  });

  it('preserves page order from sources', () => {
    const plan = planChunks({
      sources: [source('a.pdf', 10, 3), source('b.pdf', 10, 2)],
      targetBytes,
      nameFor,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.pages.map((p) => `${p.sourceName}:${p.pageIndex}`)).toEqual([
      'a.pdf:0',
      'a.pdf:1',
      'a.pdf:2',
      'b.pdf:0',
      'b.pdf:1',
    ]);
  });
});
