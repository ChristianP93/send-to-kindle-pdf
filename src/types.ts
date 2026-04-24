export interface SourceFile {
  readonly absolutePath: string;
  readonly name: string;
  readonly size: number;
}

export interface SourcePageRef {
  readonly sourcePath: string;
  readonly sourceName: string;
  readonly pageIndex: number;
}

export interface PlanEntry {
  readonly outputIndex: number;
  readonly outputName: string;
  readonly pages: readonly SourcePageRef[];
  readonly estimatedBytes: number;
  readonly sources: readonly string[];
}

export type RunMode = 'flat' | 'tree';

export interface RunSummary {
  readonly mode: RunMode;
  readonly inputCount: number;
  readonly inputTotalBytes: number;
  readonly outputDir: string;
  readonly outputs: readonly {
    readonly name: string;
    readonly bytes: number;
  }[];
  readonly skipped: readonly {
    readonly name: string;
    readonly reason: string;
  }[];
  readonly stagingDir?: string;
  readonly elapsedMs: number;
}

export type ProgressEvent =
  | { step: 'discovery'; mode: RunMode; files: number }
  | { step: 'stage'; index: number; total: number; label: string }
  | { step: 'normalize'; index: number; total: number; filename: string }
  | { step: 'plan'; chunks: number }
  | { step: 'write'; index: number; total: number; filename: string }
  | { step: 'done'; outputs: readonly string[] };

export type PrepareMode = RunMode | 'auto';

export interface PrepareForKindleOptions {
  readonly inputDir: string;
  readonly prefix: string;
  readonly targetSizeMb?: number;
  readonly outputDir?: string;
  readonly padding?: number;
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly verbose?: boolean;
  readonly mode?: PrepareMode;
  readonly keepStaging?: boolean;
  readonly normalize?: boolean;
  readonly onProgress?: (event: ProgressEvent) => void;
}

export interface PrepareForKindleResult {
  readonly summary: RunSummary;
  readonly plan: readonly PlanEntry[];
}
