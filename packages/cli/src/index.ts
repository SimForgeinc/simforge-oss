/**
 * `@simforge-oss/cli` — layer 4 of `docs/agent-authoring-architecture.md`.
 *
 * The `simforge` binary is the product; this module is its library face, so the
 * editor, the workflows in layer 5 and the tests can call the same code paths
 * without shelling out.
 *
 * ```ts
 * import { compileTemplate, loadMap, matchOnMap } from '@simforge-oss/cli';
 *
 * const bundle = await loadMap('yale-street');
 * const { report } = await matchOnMap(template, 'yale-street');
 * const { input, manifest } = compileTemplate(template, bundle, report.sites[0]!, { drawIndex: 0 });
 * ```
 *
 * Every compile, simulation and evaluation reached from here executes in the
 * native runtime (`@simforge-oss/native-runtime`); durable jobs run in the
 * native `simforge-runner`.
 *
 * @packageDocumentation
 */

export { run } from './main.js';

export {
  CliError,
  EXIT,
  exitCodeOf,
  toStructuredError,
  type StructuredError,
} from './errors.js';

export {
  ARTIFACTS,
  DEV_ASSETS,
  REPO_ROOT,
  artifactPresence,
  assertKnownMap,
  availableMaps,
  loadMap,
  mapDir,
  resolveMapSelection,
  type MapArtifactPresence,
  type MapBundle,
} from '@simforge-oss/compiler/node';

export {
  adaptTemplateNotes,
  cellSeed,
  compileTemplate,
  createMapContext,
  findSite,
  findSites,
  matchOnMap,
  matchOnMaps,
  matchSites,
  siteSummary,
  templateIdentity,
  type AdaptNote,
  type AppliedCatalogVariant,
  type CatalogVariantApplication,
  type CompiledTemplate,
  type InstanceManifest,
  type MapControlPlan,
  type MapSignalCatalog,
  type MapSignalController,
  type MapSignalHead,
  type MapSignalJunction,
  type MaterializeOptions,
  type MaterializeResult,
  type ReplayKey,
  type SiteMatch,
  type SiteSignalPlan,
  type TemplateIdentity,
} from '@simforge-oss/compiler/node';

export type { InvariantResidualReport } from '@simforge-oss/engine';

export {
  cellPaths,
  runCell,
  type CellCoords,
  type CellOptions,
  type CellResult,
} from './batch-cell.js';

export {
  detectKind,
  readInstance,
  readTemplate,
  readTraceFile,
  readTraceHandle,
  writeJsonFile,
  writeTraceFile,
  type InstanceFile,
} from '@simforge-oss/compiler/node';

export {
  CATALOG_GENERATOR_VERSION,
  CATALOG_KIND,
  CATALOG_RESEARCH_SOURCES,
  CATALOG_SLOTS_PER_MAP,
  CATALOG_TEMPLATE_SOURCES,
  CATALOG_VERSION,
  DEFAULT_CATALOG_NAMESPACE,
  INCIDENT_DOMAINS,
  INCIDENT_TAXONOMY,
  OPERATIONAL_VARIANTS,
  createScenarioCatalog,
  refreshScenarioCatalog,
  validateScenarioCatalog,
  type CatalogAcceptanceCheck,
  type CatalogEvidencePaths,
  type CatalogIssue,
  type CatalogMapProvenance,
  type CatalogProgressCounts,
  type CatalogSiteBinding,
  type CatalogSlotStatus,
  type CatalogTemplateProvenance,
  type CatalogValidationReport,
  type ScenarioCatalogManifest,
  type ScenarioCatalogSlot,
} from './catalog.js';

export { evaluate, combinedEvaluationVerdict, criticalityBand, filtersFor, type EvaluateFilterMode, type EvaluateOptions } from './commands/evaluate.js';
export { metricsSummary } from './commands/simulate.js';
export { debugScenario, type DebugOptions, type DebugPathSample } from './commands/debug.js';
export { SCHEMAS, type SchemaEntry } from './commands/schemas.js';
export { RUNNER_BINARY, RUNNER_GROUPS, resolveRunnerBinary, runRunner, runnerCandidates, type RunnerGroup, type RunnerOptions } from './commands/runner.js';
export { renderHash, renderRun, type RenderRunOptions } from './commands/render.js';
export { importOpenScenario, type ImportOptions } from './commands/import.js';
export { templateNew, type TemplateNewOptions } from './commands/template.js';
export {
  loadBuiltinRenderEngine,
  loadRenderEngine,
  type BuiltinRenderEngineId,
  type RenderEngineAdapter,
  type RenderExecutionContext,
} from '@simforge-oss/render';
