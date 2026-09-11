/** First-run onboarding screens, mounted by a host outside its dashboard chrome. */
export { HeroBackdrop } from "./HeroBackdrop";
export { WelcomeScreen } from "./WelcomeScreen";
export {
  MapSelectionScreen,
  type OnboardingMapOption,
  type OnboardingPreparation,
} from "./MapSelectionScreen";
export {
  evaluateMapDownloadGuard,
  MAP_DOWNLOAD_DISK_RESERVE_BYTES,
  type MapDownloadGuard,
} from "./disk-guard";
