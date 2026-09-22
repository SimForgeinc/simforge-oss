import type { HostSurface, MapInstallPanelProps, RenderSettingsSurfaceType } from "@/app/host/contract";
import { RenderSettings } from "./RenderSettings";
import { MapLibrarySurface as MapLibrary } from "./MapLibrarySurface";

/**
 * A cloud host's surfaces: the ones whose subject still exists here.
 *
 * A hosted deployment has no computer of its own to describe. Maps stream from
 * object storage, weights run on managed capacity, credentials belong to the
 * signed-in account rather than an OS vault, and the deployment IS SimCloud —
 * so the map library, the model store, local settings, the SimCloud connector
 * and first-run runtime/map onboarding are `null` here. Their routes answer
 * `notFound()` and their modules never enter this build, because this barrel
 * never imports `../local/*`.
 *
 * Render Settings survives with its meaning changed: choosing a graphics level
 * is a preference of THIS BROWSER, not a profile prepared on a machine, so the
 * cloud version keeps the quality choice and the browser's own cache readout
 * and drops map preparation and the cache re-download entirely.
 */

export const RenderSettingsSurface: RenderSettingsSurfaceType = RenderSettings;
export const SettingsSurface: HostSurface = null;
/** The catalog survives; residency on a disk does not. See the module. */
export const MapLibrarySurface: HostSurface = MapLibrary;
export const ModelsSurface: HostSurface = null;
export const SimCloudSurface: HostSurface = null;
export const OnboardingWelcomeSurface: HostSurface = null;
export const OnboardingMapsSurface: HostSurface = null;
export const OnboardingNativeRenderSurface: HostSurface = null;
export const MapInstallPanel: HostSurface<MapInstallPanelProps> = null;
/** No second account to connect, and no vault to keep its credential in. */
export const CloudConnectorChip: HostSurface<{ onNavigate?: () => void }> = null;
export const CloudConnectorSheet: HostSurface = null;
