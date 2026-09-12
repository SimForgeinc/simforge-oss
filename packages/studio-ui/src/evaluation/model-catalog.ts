/**
 * Re-export of the Alpamayo model catalog.
 *
 * The authoritative table lives in `@simforge-oss/model-store/catalog`, next
 * to the installer that acts on it, and has zero transitive imports so this
 * subpath stays safe for the map-free browser portal bundle.
 *
 * It is re-exported here because both product UIs already resolve
 * `@simforge-oss/studio-ui/evaluation/model-catalog`, and because the catalog
 * is a product-surface concern as much as an installer one. There is still
 * exactly one table: the desktop store, the desktop Models screen, the shared
 * evaluation launcher and the SimCloud portal all read these consts.
 *
 * Requires `@simforge-oss/model-store` in this package's dependencies.
 */
import {
  MODEL_CATALOG,
  MODEL_FAMILIES,
  MODEL_QUANTS_BY_FAMILY,
  MODEL_RIG_PRESETS,
  UPSTREAM_CODE_LICENSE,
  WEIGHTS_LICENSE_BLOB_SHA,
  WEIGHTS_LICENSE_ID,
  catalogEntry,
  isModelFamilyId,
  quantOffer,
  rigPresetForCameras,
} from "@simforge-oss/model-store/catalog";

export {
  MODEL_CATALOG,
  MODEL_FAMILIES,
  MODEL_QUANTS_BY_FAMILY,
  MODEL_RIG_PRESETS,
  UPSTREAM_CODE_LICENSE,
  WEIGHTS_LICENSE_BLOB_SHA,
  WEIGHTS_LICENSE_ID,
  catalogEntry,
  isModelFamilyId,
  quantOffer,
  rigPresetForCameras,
};
export type {
  ModelFamilyId,
  ModelQuant,
  ModelQuantStatus,
  ModelExecutionStatus,
  ModelCapabilities,
  ModelQuantOffer,
  ModelSidecar,
  ModelLicense,
  ModelCameraContract,
  ModelCatalogEntry,
  ModelInstallState,
  ModelInstallStep,
  ModelExecutionEligibility,
} from "@simforge-oss/model-store/catalog";
