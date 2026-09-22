/**
 * The surfaces this host mounts.
 *
 * OSS Studio is the local desktop host, so it re-exports the local set. A
 * hosted deployment replaces THIS FILE with one that re-exports `./cloud`,
 * exactly the way it already replaces `lib/host/kind.ts` and
 * `lib/host/capabilities.ts`: which host this is stays a declaration, never a
 * guess, and the surfaces the other host owns never reach this build's bundle.
 *
 * Every page imports from here. `./local/*` and `./cloud/*` are private to
 * this directory — see `./contract.ts`.
 */
export * from "./local";
export type {
  HostSurface,
  MapInstallPanelProps,
  RenderSettingsProps,
  RenderSettingsSurfaceType,
} from "./contract";
