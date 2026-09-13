/**
 * The stable surface every flow suite imports. Modules under `e2e/support`
 * may be reorganised; this file is the contract.
 */
export { test, e2eTest, expect, type E2eFixtures } from "./fixtures";
export {
  createE2eContext,
  MAP_CORPUS_PROFILES,
  type CreateE2eContextOptions,
  type E2eContext,
} from "./context";
export {
  DEFAULT_ROUTE,
  launchBrowserStudio,
  launchElectronStudio,
  launchStudio,
  type LaunchBrowserStudioOptions,
  type LaunchElectronStudioOptions,
  type StudioSession,
} from "./session";
export { startLocalHost, requestBrowserTicketUrl, type LocalHost, type StartLocalHostOptions } from "./host";
export { recordEvidence, writeEvidence, type EvidenceTarget } from "./evidence";
export {
  DEPLOYMENT_E2E_EVIDENCE_SCHEMA,
  validateDeploymentEvidence,
  writeDeploymentEvidence,
  type DeploymentE2eEvidence,
} from "./provenance";
export {
  definePrerequisite,
  PREREQUISITES,
  PrerequisiteError,
  prerequisiteStatus,
  requirePrerequisite,
  requirePrerequisites,
  type PrerequisiteSpec,
  type PrerequisiteStatus,
} from "./prerequisites";
export { installedMapIds, linkInstalledMaps } from "./maps";
export {
  startFixtureServer,
  type FixtureResponse,
  type FixtureRoute,
  type FixtureServer,
  type RecordedRequest,
  type StartFixtureServerOptions,
} from "./fixture-server";
export { runCli, type CliResult, type RunCliOptions } from "./cli";
export { currentHostMode, currentMode, E2E_ENV, envValue, type E2eMode, type HostMode } from "./env";
export { CLI_BIN, E2E_ROOT, EVIDENCE_DIR, FIXTURES_DIR, REPO_ROOT, REPORT_DIR, RESULTS_DIR, STUDIO_ROOT } from "./paths";
