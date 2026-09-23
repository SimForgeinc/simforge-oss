export { refitXodrElevation, REFIT_FINGERPRINT, REFIT_PARAMS, REFIT_REVISION, type RefitResult, type RoadChange } from './refit.js';
export { runRefit, changesMarkdown, REFIT_GATES, type MapRefitReport, type RunRefitResult } from './report.js';
export { surveySurface, type SurfaceSurvey } from './evaluate.js';
export { verifyContinuity, CONTACT_SLOPE_SPAN_M, type ContinuityReport } from './verify.js';
export { structuralDiff, scanXml, formatNumber, xodrGeometrySha256, type StructuralDiffResult } from './xodr-text.js';
