import { AMBIENT_TRAFFIC_EXTENSION_KEY, validateAmbientTrafficProfileExtension } from "@simforge-oss/engine";
import { parseTemplate, withPinnedSimulation, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

/**
 * The ambient profile a document written before pinning resolves to when it
 * names none (`defaultAmbientTrafficProfile`). The one-time pin writes it
 * explicitly, because once a document carries a `simulation` block a missing
 * profile means `off`.
 */
export const LEGACY_AMBIENT_PROFILE = Object.freeze({ version: 1, preset: "city", seed: "ambient-1" });

export type DocumentPinOutcome =
  | { kind: "unchanged"; content: ScenarioTemplateV2; seed: string }
  | { kind: "pinned"; content: ScenarioTemplateV2; seed: string; addedSimulation: boolean; addedAmbientProfile: boolean }
  | { kind: "invalid_ambient_profile"; issues: readonly string[] }
  | { kind: "unparseable"; reason: string };

/**
 * The one-time pin of a stored draft (`docs/engineering/document-pinning.md`):
 *
 * - `simulation: { seed, dtS: 0.02 }` with the seed it resolves to today (its
 *   template id), so its simulation is byte-identical after pinning;
 * - the legacy ambient default (City, `ambient-1`) written explicitly where the
 *   document names no profile, so pinning does not switch its traffic off.
 *
 * A document that already has a `simulation` block is current-format and is
 * left alone. A malformed ambient profile is NOT repaired: that is now a
 * validation error the author must see, and inventing City traffic for it is
 * the silent fallback the pin exists to end.
 */
export function pinStoredDocument(raw: unknown): DocumentPinOutcome {
  let template: ScenarioTemplateV2;
  try {
    template = parseTemplate(raw);
  } catch (error) {
    return { kind: "unparseable", reason: error instanceof Error ? error.message : String(error) };
  }
  if (template.simulation) return { kind: "unchanged", content: template, seed: template.simulation.seed };
  const ambient = validateAmbientTrafficProfileExtension(template.extensions);
  if (ambient.kind === "invalid") return { kind: "invalid_ambient_profile", issues: ambient.issues };
  const addedAmbientProfile = ambient.kind === "absent";
  const withProfile: ScenarioTemplateV2 = addedAmbientProfile
    ? { ...template, extensions: { ...(template.extensions ?? {}), [AMBIENT_TRAFFIC_EXTENSION_KEY]: { ...LEGACY_AMBIENT_PROFILE } } }
    : template;
  const content = parseTemplate(withPinnedSimulation(withProfile));
  return { kind: "pinned", content, seed: content.simulation!.seed, addedSimulation: true, addedAmbientProfile };
}
