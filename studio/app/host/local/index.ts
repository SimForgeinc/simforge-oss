import type { HostSurface, MapInstallPanelProps, RenderSettingsSurfaceType } from "@/app/host/contract";
import { RenderSettings } from "./RenderSettings";
import { SettingsSurface as Settings } from "./SettingsSurface";
import { MapLibrarySurface as MapLibrary } from "./MapLibrarySurface";
import { ModelsSurface as Models } from "./ModelsSurface";
import { SimCloudSurface as SimCloud } from "./SimCloudSurface";
import { OnboardingWelcomeSurface as OnboardingWelcome } from "./OnboardingWelcomeSurface";
import { OnboardingMapsSurface as OnboardingMaps } from "./OnboardingMapsSurface";
import { OnboardingNativeRenderSurface as OnboardingNativeRender } from "./OnboardingNativeRenderSurface";
import { LocalMapPreparationPanel } from "./LocalMapPreparationPanel";
import { CloudAccountChip, CloudAccountSheet } from "./cloud/CloudAccountChip";

/**
 * The local desktop host's surfaces.
 *
 * This installation owns a computer, so every surface about that computer is
 * present: the map library that installs closures on its disk, the model store
 * that downloads weights to it, the settings that name its data folder and put
 * provider keys in its OS vault, the SimCloud page that connects it to the
 * service, and first-run onboarding for the runtime and the first maps.
 *
 * Reached only through `@/app/host`; see `../contract.ts`.
 */

export const RenderSettingsSurface: RenderSettingsSurfaceType = RenderSettings;
export const SettingsSurface: HostSurface = Settings;
export const MapLibrarySurface: HostSurface = MapLibrary;
export const ModelsSurface: HostSurface = Models;
export const SimCloudSurface: HostSurface = SimCloud;
export const OnboardingWelcomeSurface: HostSurface = OnboardingWelcome;
export const OnboardingMapsSurface: HostSurface = OnboardingMaps;
export const OnboardingNativeRenderSurface: HostSurface = OnboardingNativeRender;
export const MapInstallPanel: HostSurface<MapInstallPanelProps> = LocalMapPreparationPanel;
/**
 * The SimCloud connector: the switcher's account line and the sheet its
 * sign-in opens. Both write a credential into THIS installation's vault, which
 * is why they are local: a cloud host authenticates the person itself and has
 * no second account to connect, nor a vault to put one in.
 */
export const CloudConnectorChip: HostSurface<{ onNavigate?: () => void }> = CloudAccountChip;
export const CloudConnectorSheet: HostSurface = CloudAccountSheet;
