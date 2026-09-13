export type TraceRenderCamera = 'pair' | 'follow-ego' | 'overview';
export type TraceRenderFormat = 'stills' | 'video' | 'both';

export interface TraceRenderOptions {
  readonly instance: string;
  readonly trace: string;
  readonly out: string;
  readonly times?: readonly number[] | null;
  readonly width?: number;
  readonly height?: number;
  readonly scale?: number;
  readonly fps?: number;
  readonly fullClip?: boolean;
  readonly devAssets?: string | null;
  readonly redact?: boolean;
  readonly camera?: TraceRenderCamera;
  readonly format?: TraceRenderFormat;
}

export interface TraceRenderResult {
  readonly manifest: Record<string, unknown>;
  readonly manifestPath: string;
  readonly outDir: string;
}

export function renderTrace(options: TraceRenderOptions): Promise<TraceRenderResult>;
export function fullClipFrameTimes(trace: { ticks: { t: readonly number[] } }, fps: number): number[];
export function runTraceRenderCli(argv?: readonly string[]): Promise<TraceRenderResult>;
