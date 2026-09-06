/**
 * The SimForge Studio product surface a host mounts under `/dashboard/scenario`.
 *
 * Everything else the hosts consume — the UI kit, dashboard chrome providers,
 * editor regions reused by Drive, scenario contracts, the playback worker
 * client — is exported by subpath so a host imports exactly the module it
 * renders. See `package.json#exports`.
 */
export { StudioHostProvider, useStudioHost } from "./host";
export { ScenarioDatasetsClient } from "./scenario/ScenarioDatasetsClient";
export { ScenarioDatasetDetailClient } from "./scenario/dataset/ScenarioDatasetDetailClient";
export { ScenarioEditorClient } from "./scenario/editor/ScenarioEditorClient";
export { ScenarioReviewQueue } from "./scenario/review/ScenarioReviewQueue";
export { ScenarioWorkspaceStatusProvider, ScenarioWorkspaceErrorState } from "./scenario/editor/status";
export {
  ScenarioDatasetError,
  ScenarioDatasetLoading,
  ScenarioEditorLoading,
  ScenarioIndexLoading,
  ScenarioReviewError,
  ScenarioReviewLoading,
  ScenarioSegmentError,
} from "./scenario/route-states";
