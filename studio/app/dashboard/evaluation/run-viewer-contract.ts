import type { ModelHealthAssessment, ReasoningRecord } from "@simforge-oss/evaluation/drive-evidence";

export type JsonObject = Record<string, unknown>;
export type RecordedStep = {
  step: number;
  tS: number;
  pose?: { speedMps?: number; x?: number; y?: number; yawRad?: number };
  latencyMs?: number;
  miss?: boolean | number;
  applied?: string;
  crossTrackM?: number | null;
  reasoning?: ReasoningRecord;
  extras?: JsonObject;
};
export type RunView = {
  ref: string;
  label: string;
  run: JsonObject;
  result: JsonObject | null;
  score: JsonObject | null;
  health: ModelHealthAssessment;
  videoUrl: string | null;
  stepsUrl: string | null;
  soloClipUrl: string | null;
};
export type RunDirectoryView = {
  ref: string;
  kind: "heat" | "solo";
  videoUrl: string | null;
  videoPolicyOffsetS: number | null;
  report: JsonObject | null;
  runs: RunView[];
};
export function runViewerHref(ref: string): string {
  return `/dashboard/evaluation/viewer?ref=${encodeURIComponent(ref)}`;
}
export function runFileUrl(ref: string, file: string): string {
  return `/api/simforge/drive/files?ref=${encodeURIComponent(ref)}&file=${encodeURIComponent(file)}`;
}

/** Time relative to the first policy frame; the solo video's prologue is excluded by the caller. */
export function recordedStepAt(steps: readonly RecordedStep[], videoTime: number): RecordedStep | null {
  if (!steps.length || videoTime < 0) return null;
  const target = steps[0]!.tS + videoTime;
  let low = 0, high = steps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (steps[middle]!.tS <= target + 1e-6) low = middle + 1;
    else high = middle;
  }
  return steps[Math.max(0, low - 1)]!;
}
