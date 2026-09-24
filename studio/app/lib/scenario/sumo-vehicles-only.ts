import { AMBIENT_TRAFFIC_EXTENSION_KEY, validateAmbientTrafficProfileExtension } from "@simforge-oss/engine";
import { AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY, profileForTrafficSource } from "@simforge-oss/playback/traffic";
import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

export type SumoVehiclesOnlyOutcome =
  | { kind: "unchanged"; reason: "not_sumo" | "no_profile" | "off" | "vehicles_only" }
  | { kind: "updated"; content: ScenarioTemplateV2; pedestrianShare: number; cyclistShare: number }
  | { kind: "invalid_ambient_profile"; issues: readonly string[] }
  | { kind: "unparseable"; reason: string };

/**
 * The one-time repair of a stored draft that runs SUMO traffic with a profile
 * asking for pedestrians or cyclists (docs/engineering/no-silent-fallbacks.md).
 *
 * SUMO generates vehicles only, and the engine refuses such a profile
 * (`sumo_road_user_share_unsupported`), so these drafts cannot simulate. The
 * editor now records `pedestrianShare: 0, cyclistShare: 0` whenever SUMO is
 * chosen (`profileForTrafficSource`). This writes the same explicit change
 * into drafts saved before that, touching only the two shares of the stored
 * profile.
 *
 * Nothing else is inferred. A draft without a stored profile keeps what it
 * resolves to: `off` once pinned, and SUMO refuses that by design. A malformed
 * profile is reported, not repaired.
 */
export function sumoVehiclesOnlyStoredDocument(raw: unknown): SumoVehiclesOnlyOutcome {
  let template: ScenarioTemplateV2;
  try {
    template = parseTemplate(raw);
  } catch (error) {
    return { kind: "unparseable", reason: error instanceof Error ? error.message : String(error) };
  }
  const extensions = template.extensions ?? {};
  if (extensions[AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY] !== "sumo") return { kind: "unchanged", reason: "not_sumo" };
  const stored = validateAmbientTrafficProfileExtension(extensions);
  if (stored.kind === "invalid") return { kind: "invalid_ambient_profile", issues: stored.issues };
  if (stored.kind === "absent") return { kind: "unchanged", reason: "no_profile" };
  if (stored.profile.preset === "off") return { kind: "unchanged", reason: "off" };
  if (profileForTrafficSource("sumo", stored.profile) === stored.profile) return { kind: "unchanged", reason: "vehicles_only" };
  const rawProfile = extensions[AMBIENT_TRAFFIC_EXTENSION_KEY] as Record<string, unknown>;
  const content = parseTemplate({
    ...template,
    extensions: { ...extensions, [AMBIENT_TRAFFIC_EXTENSION_KEY]: { ...rawProfile, pedestrianShare: 0, cyclistShare: 0 } },
  });
  return {
    kind: "updated",
    content,
    pedestrianShare: stored.profile.pedestrianShare,
    cyclistShare: stored.profile.cyclistShare,
  };
}
