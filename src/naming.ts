const PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidPrefixError extends Error {
  constructor(prefix: string) {
    super(`Invalid prefix "${prefix}": only letters, digits, hyphen and underscore are allowed.`);
    this.name = 'InvalidPrefixError';
  }
}

export class InvalidPaddingError extends Error {
  constructor(padding: number) {
    super(`Invalid padding ${padding}: must be an integer between 1 and 9.`);
    this.name = 'InvalidPaddingError';
  }
}

/**
 * Thrown when a run would produce more outputs than the chosen `--padding`
 * digits can represent (e.g. a 4-digit padding caps at 9999 chunks).
 *
 * We deliberately do NOT auto-extend the padding on overflow: filenames are a
 * user-visible contract (sort order, archive scripts, Kindle library naming)
 * and silently switching from 4 to 5 digits mid-library would break
 * lexicographic ordering of previously generated files.
 */
export class CounterOverflowError extends Error {
  constructor(readonly max: number) {
    super(
      `Output counter exceeded the maximum value of ${max}. Increase --padding or reduce output count.`,
    );
    this.name = 'CounterOverflowError';
  }
}

export function validatePrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new InvalidPrefixError(prefix);
  }
}

export function validatePadding(padding: number): void {
  if (!Number.isInteger(padding) || padding < 1 || padding > 9) {
    throw new InvalidPaddingError(padding);
  }
}

export function maxCounterForPadding(padding: number): number {
  validatePadding(padding);
  return 10 ** padding - 1;
}

export interface NameGeneratorOptions {
  readonly prefix: string;
  readonly padding?: number;
}

export function createNameGenerator(options: NameGeneratorOptions): (index: number) => string {
  const padding = options.padding ?? 4;
  validatePrefix(options.prefix);
  validatePadding(padding);
  const max = maxCounterForPadding(padding);

  return (index: number): string => {
    if (!Number.isInteger(index) || index < 1) {
      throw new RangeError(`Output index must be a positive integer, received ${index}`);
    }
    if (index > max) {
      throw new CounterOverflowError(max);
    }
    return `${options.prefix}-${String(index).padStart(padding, '0')}.pdf`;
  };
}
