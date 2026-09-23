import type { HostSurface, MapDownloadsSurfaceType, MapInstallPanelProps, RenderSettingsSurfaceType, WorkspaceChipProps } from "@/app/host/contract";
import { RenderSettings } from "./RenderSettings";
import { MapDownloads } from "./MapDownloads";
import { WorkspaceChip as CloudWorkspaceChip } from "./WorkspaceChip";
import type { ReactNode } from "react";

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
 * Map Downloads survives the same way: there is no disk to install closures
 * on, but there is this browser's map cache, so it downloads maps there at the
 * chosen render setting instead.
 *
 * Render Settings survives with its meaning changed: choosing a graphics level
 * is a preference of THIS BROWSER, not a profile prepared on a machine, so the
 * cloud version keeps the quality choice and the browser's own cache readout
 * and drops map preparation and the cache re-download entirely.
 */

export const RenderSettingsSurface: RenderSettingsSurfaceType = RenderSettings;
export const SettingsSurface: HostSurface = null;
/**
 * The catalog survives, and gains a residency of its own: this browser's map
 * cache. Shown inline in the app switcher; see the module.
 */
export const MapDownloadsSurface: MapDownloadsSurfaceType = MapDownloads;
export const ModelsSurface: HostSurface = null;
export const SimCloudSurface: HostSurface = null;
export const OnboardingGateSurface: HostSurface<{ children: ReactNode }> = null;
export const OnboardingWelcomeSurface: HostSurface = null;
export const OnboardingMapsSurface: HostSurface = null;
export const OnboardingNativeRenderSurface: HostSurface = null;
export const MapInstallPanel: HostSurface<MapInstallPanelProps> = null;
/** No second account to connect, and no vault to keep its credential in. */
export const CloudConnectorChip: HostSurface<{ onNavigate?: () => void }> = null;
export const CloudConnectorSheet: HostSurface = null;
/** The tenant you act in, with a quick switch to any other you belong to. */
export const WorkspaceChip: HostSurface<WorkspaceChipProps> = CloudWorkspaceChip;

export { useDatasetCloudHome } from "./useDatasetCloudHome";
