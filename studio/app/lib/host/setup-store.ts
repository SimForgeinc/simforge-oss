import "server-only";
import { SCENARIO_AUTHORING_QUALITY_IDS, type ScenarioAuthoringQuality } from "@simforge-oss/studio-host";
import { queryOne } from "@/app/lib/db/data-api";
import type { StudioSetup, StudioSetupMode } from "./setup";

/**
 * The installation's first-run setup row (`simforge.local_studio_setup`,
 * always id = 1). Reading a missing row is not an error: a data root that has
 * never been set up simply has no row, which is what the onboarding gate asks
 * about.
 */

type SetupRow = {
  completed_at: Date | string | null;
  mode: string | null;
  quality: string | null;
};

const SETUP_MODES: readonly StudioSetupMode[] = ["cloud", "local"];

export function isStudioSetupMode(value: unknown): value is StudioSetupMode {
  return SETUP_MODES.some((mode) => mode === value);
}

export function isStudioSetupQuality(value: unknown): value is ScenarioAuthoringQuality {
  return SCENARIO_AUTHORING_QUALITY_IDS.some((quality) => quality === value);
}

function toSetup(row: SetupRow | null): StudioSetup {
  const completedAt = row?.completed_at ?? null;
  return {
    completedAt: completedAt instanceof Date ? completedAt.toISOString() : completedAt,
    mode: isStudioSetupMode(row?.mode) ? row.mode : null,
    quality: isStudioSetupQuality(row?.quality) ? row.quality : null,
  };
}

export async function readLocalStudioSetup(): Promise<StudioSetup> {
  return toSetup(
    await queryOne<SetupRow>(
      "SELECT completed_at, mode, quality FROM simforge.local_studio_setup WHERE id = 1",
    ),
  );
}

/**
 * Record a finished setup. The timestamp is the service's, never the client's,
 * and re-completing (Settings > redo setup) keeps the original `created_at`
 * while moving `completed_at` forward.
 */
export async function completeLocalStudioSetup(input: {
  mode: StudioSetupMode;
  quality: ScenarioAuthoringQuality;
}): Promise<StudioSetup> {
  return toSetup(
    await queryOne<SetupRow>(
      `INSERT INTO simforge.local_studio_setup (id, completed_at, mode, quality)
       VALUES (1, NOW(), :mode, :quality)
       ON CONFLICT (id) DO UPDATE
         SET completed_at = NOW(),
             mode = EXCLUDED.mode,
             quality = EXCLUDED.quality,
             updated_at = NOW()
       RETURNING completed_at, mode, quality`,
      { mode: input.mode, quality: input.quality },
    ),
  );
}
