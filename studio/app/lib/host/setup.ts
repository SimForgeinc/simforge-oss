import type { ScenarioAuthoringQuality } from "@simforge-oss/studio-host";

/**
 * First-run setup state of this installation, read and written through the
 * local service so it follows the data root rather than a browser profile.
 * The wire shape is shared with the route handler that serves it.
 */
export type StudioSetupMode = "cloud" | "local";

export type StudioSetup = {
  /** ISO timestamp of the completed onboarding, or null while it is still pending. */
  completedAt: string | null;
  mode: StudioSetupMode | null;
  quality: ScenarioAuthoringQuality | null;
};

const SETUP_PATH = "/api/simforge/host/setup";

export async function readStudioSetup(signal?: AbortSignal): Promise<StudioSetup> {
  const response = await fetch(SETUP_PATH, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Studio setup state could not be read (${response.status}).`);
  return (await response.json()) as StudioSetup;
}

/** Marks onboarding done; the service owns the completion timestamp. */
export async function completeStudioSetup(
  input: { mode: StudioSetupMode; quality: ScenarioAuthoringQuality },
  signal?: AbortSignal,
): Promise<StudioSetup> {
  const response = await fetch(SETUP_PATH, {
    method: "PUT",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) throw new Error(`Studio setup state could not be saved (${response.status}).`);
  return (await response.json()) as StudioSetup;
}
