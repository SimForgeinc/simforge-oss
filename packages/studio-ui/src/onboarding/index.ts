/**
 * The hero flow: the first-run onboarding screens and the map library, which
 * share one shell, one backdrop and one map grid. Mounted by a host outside
 * its dashboard chrome (onboarding) or inside its main area (the library).
 */
export { HeroBackdrop } from "./HeroBackdrop";
export { HeroFlowShell } from "./HeroFlowShell";
export { WelcomeScreen } from "./WelcomeScreen";
export {
  NativeRenderScreen,
  type NativeRenderInstallRow,
  type NativeRenderInstallView,
} from "./NativeRenderScreen";
export {
  MapSelectionScreen,
  type OnboardingMapOption,
  type OnboardingPreparation,
} from "./MapSelectionScreen";
export {
  MapLibraryScreen,
  type MapLibraryInstall,
  type MapLibraryMap,
} from "./MapLibraryScreen";
export { MapCard, MapGrid, type MapGridMap } from "./MapGrid";
export {
  evaluateMapDownloadGuard,
  MAP_DOWNLOAD_DISK_RESERVE_BYTES,
  type MapDownloadGuard,
} from "./disk-guard";
