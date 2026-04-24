import { describe, expect, it } from 'vitest';

import {
  CounterOverflowError,
  InvalidPaddingError,
  InvalidPrefixError,
  createNameGenerator,
  maxCounterForPadding,
  validatePrefix,
} from '../../src/naming.js';

describe('validatePrefix', () => {
  it('accepts alphanumeric, hyphen and underscore', () => {
    expect(() => validatePrefix('one-piece')).not.toThrow();
    expect(() => validatePrefix('one_piece_2')).not.toThrow();
    expect(() => validatePrefix('ABC123')).not.toThrow();
  });

  it('rejects prefixes with spaces or special characters', () => {
    expect(() => validatePrefix('one piece')).toThrow(InvalidPrefixError);
    expect(() => validatePrefix('one/piece')).toThrow(InvalidPrefixError);
    expect(() => validatePrefix('')).toThrow(InvalidPrefixError);
    expect(() => validatePrefix('..')).toThrow(InvalidPrefixError);
  });
});

describe('maxCounterForPadding', () => {
  it('computes 10^padding - 1', () => {
    expect(maxCounterForPadding(1)).toBe(9);
    expect(maxCounterForPadding(2)).toBe(99);
    expect(maxCounterForPadding(4)).toBe(9999);
    expect(maxCounterForPadding(6)).toBe(999_999);
  });

  it('rejects invalid padding values', () => {
    expect(() => maxCounterForPadding(0)).toThrow(InvalidPaddingError);
    expect(() => maxCounterForPadding(10)).toThrow(InvalidPaddingError);
    expect(() => maxCounterForPadding(-1)).toThrow(InvalidPaddingError);
    expect(() => maxCounterForPadding(1.5)).toThrow(InvalidPaddingError);
  });
});

describe('createNameGenerator', () => {
  it('formats names with default 4-digit padding', () => {
    const gen = createNameGenerator({ prefix: 'one-piece' });
    expect(gen(1)).toBe('one-piece-0001.pdf');
    expect(gen(42)).toBe('one-piece-0042.pdf');
    expect(gen(9999)).toBe('one-piece-9999.pdf');
  });

  it('honors custom padding', () => {
    const gen = createNameGenerator({ prefix: 'x', padding: 2 });
    expect(gen(1)).toBe('x-01.pdf');
    expect(gen(99)).toBe('x-99.pdf');
  });

  it('throws CounterOverflowError when exceeding max for padding', () => {
    const gen = createNameGenerator({ prefix: 'x', padding: 2 });
    expect(() => gen(100)).toThrow(CounterOverflowError);

    const gen4 = createNameGenerator({ prefix: 'x' });
    expect(() => gen4(10_000)).toThrow(CounterOverflowError);
  });

  it('rejects non-positive indexes', () => {
    const gen = createNameGenerator({ prefix: 'x' });
    expect(() => gen(0)).toThrow(RangeError);
    expect(() => gen(-1)).toThrow(RangeError);
    expect(() => gen(1.5)).toThrow(RangeError);
  });

  it('validates prefix at generator creation time', () => {
    expect(() => createNameGenerator({ prefix: 'bad prefix' })).toThrow(InvalidPrefixError);
  });

  it('validates padding at generator creation time', () => {
    expect(() => createNameGenerator({ prefix: 'x', padding: 0 })).toThrow(InvalidPaddingError);
  });
});
