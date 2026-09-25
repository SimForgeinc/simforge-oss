/**
 * "Export for CLI" feature flag.
 *
 * `SIMFORGE_SCENARIO_PACKAGE_EXPORT=1|0` wins when set. Unset, the export is
 * on in dev (and in local hosts, which run as dev) and off in staging and
 * prod, so promotion carries the code without turning the feature on there.
 */
export function scenarioPackageExportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.SIMFORGE_SCENARIO_PACKAGE_EXPORT?.trim();
  if (explicit === "1" || explicit === "true") return true;
  if (explicit === "0" || explicit === "false") return false;
  const environment = env.SIMFORGE_ENV?.trim() || "dev";
  return environment === "dev" || environment === "local";
}

export const SCENARIO_PACKAGE_EXPORT_DISABLED_REASON =
  "Export for CLI is not enabled on this deployment (SIMFORGE_SCENARIO_PACKAGE_EXPORT).";

/** The host capability the "Export for CLI" menu item is shown for. */
export function scenarioPackageExportAction(env: NodeJS.ProcessEnv = process.env): { available: boolean; reason: string | null } {
  return scenarioPackageExportEnabled(env)
    ? { available: true, reason: null }
    : { available: false, reason: SCENARIO_PACKAGE_EXPORT_DISABLED_REASON };
}
