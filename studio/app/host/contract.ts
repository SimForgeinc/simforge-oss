import type { ComponentType } from "react";
import type * as stylex from "@stylexjs/stylex";
import type { LocalMapDescriptor } from "@/app/lib/cloud/maps";

/**
 * The surfaces a host mounts, as types both hosts are written against.
 *
 * Studio ships two hosts from one tree. The local desktop host owns a machine:
 * it installs map closures and model weights on a disk, keeps credentials in
 * an OS vault, runs a native renderer from a binary it downloaded, and connects
 * that installation to SimCloud. A cloud host owns none of those things — it IS
 * the service the local host would connect to — so the surfaces about the
 * machine are not "disabled" there, they do not exist.
 *
 * `null` is therefore a first-class value of every surface type: the host that
 * does not have the concept declares so, routes answer `notFound()`, and the
 * module never reaches the bundle at all because the active barrel never
 * imports it. Both hosts declare the SAME type for each name, so a page
 * type-checks identically whichever host it is built for.
 *
 * Pages import from `@/app/host`. Importing `@/app/host/local/*` or
 * `@/app/host/cloud/*` from outside `app/host/` is what the import guard in
 * `app/host/__tests__/host-modules.test.ts` exists to prevent: that import
 * reintroduces the leak the module boundary removes.
 */

/** A surface one host mounts and the other does not have at all. */
export type HostSurface<P = object> = ComponentType<P> | null;

/**
 * Render Settings is shown inline in the app switcher, which takes it back.
 * Both hosts have it — the concept survives, its meaning does not: local
 * prepares a machine profile, cloud sets a preference of this browser.
 */
export type RenderSettingsProps = { onDone: () => void };
export type RenderSettingsSurfaceType = ComponentType<RenderSettingsProps>;

/** The map-gallery panel that reports and installs a map's local closures. */
export type MapInstallPanelProps = {
  map: LocalMapDescriptor;
  xstyle?: stylex.StyleXStyles;
};

/** Dataset home is composed by the host before any connector effects mount. */
/** Rendered in the switcher footer beside the account on hosts with tenants. */
export type WorkspaceChipProps = { identity: import("@simforge-oss/studio-host").StudioHostIdentity; onNavigate?: () => void };

export type DatasetHomeHook = () => import("@simforge-oss/studio-ui/scenario/ScenarioDatasetsClient").DatasetCloudHome;
