import { simforgeEnv } from "../../../lib/simforge-env";

/**
 * The execution-package compiler CONTRACT an export row is dispatched under: the compiler worker
 * (`worker/compiler-core.ts`) claims only exports whose `compiler_version` equals its own. It names
 * the contract (`uniscenario.execution-package/v1` compiled from a stored trace), not a build, and
 * it is not provenance: what produced a revision's motion is its result's engine and the OSS
 * release recorded on the revision (`revisions.engine_sem_ver`, `revisions.oss_release`).
 */
export const DEFAULT_EXPORT_COMPILER_CONTRACT = "uniscenario-compiler@2.0.0";

/** `SIMFORGE_COMPILER_VERSION` overrides the contract a deployment's compiler fleet claims. */
export function exportCompilerContract(): string {
  return simforgeEnv("COMPILER_VERSION")?.trim() || DEFAULT_EXPORT_COMPILER_CONTRACT;
}
