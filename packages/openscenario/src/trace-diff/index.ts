export {
  COMMON_DURATION_S,
  COMMON_SAMPLE_HZ,
  TRACE_COMPARISON_FORMAT_VERSION,
} from './types.js';
export type * from './types.js';
export {
  commonTimeline,
  headingDeltaRad,
  mapEntities,
  normalizeCanonicalTrace,
  normalizeExternalTrace,
  wrapHeadingRad,
} from './normalize.js';
export {
  buildDualTracePlaybackData,
  compareNormalizedTraces,
  COMPARISON_PROFILES,
  toComparisonUiModel,
} from './compare.js';
export {
  buildSimulationDualPlayback,
  describeSimulationMotionDiff,
  diffSimulationTraces,
  MOTION_IDENTICAL_HEADING_RAD,
  MOTION_IDENTICAL_POSITION_M,
  SIMULATION_MOTION_DIFF_FORMAT,
  type SimulationDualPlayback,
  type SimulationMotionDiff,
} from './simulation-diff.js';
