import { contentHash, type AmbientTrafficProvenance, type SimResult, type SimScenarioInput } from '@simforge-oss/engine';

/**
 * The `scenario-instance` envelope playback admits for one executed input:
 * the compiler's materialization manifest re-keyed to the exact input the
 * engine ran (ambient actors included), with its ambient provenance.
 *
 * Shared by the editor's scenario worker (its local preview) and every host
 * that replays an authoritative trace from its resolution record, so both
 * build the same instance for the same input.
 */
export function scenarioInstanceEnvelope(
  baseManifest: Record<string, any>,
  input: SimScenarioInput,
  provenance: AmbientTrafficProvenance,
  engineIssues: ReadonlyArray<SimResult['issues'][number]> = [],
): Record<string, unknown> {
  // The blank-world path may remove its schema-only seed actor after ambient
  // population has been materialized. Always derive identity from the exact
  // input returned to playback rather than trusting an earlier intermediate
  // hash; otherwise the editor rejects its own freshly prepared scenario.
  const generatedInputHash = contentHash(input);
  const normalizedProvenance = provenance.generatedInputHash === generatedInputHash
    ? provenance
    : { ...provenance, generatedInputHash };
  const authored = new Map(((baseManifest['actors'] ?? []) as Array<Record<string, unknown>>).map((actor) => [actor['id'], actor]));
  const actors = input.actors.map((actor) => authored.get(actor.id) ?? {
    id: actor.id,
    actorKind: actor.kind,
    roleKind: 'ambient',
    origin: 'ambient',
    timelineVisible: false,
    editable: false,
    laneRsl: actor.initial.laneRef?.rsl ?? null,
    spawnS: actor.initial.laneRef?.s ?? 0,
    initialSpeedMps: actor.initial.speedMps,
    bindingStatus: 'generated',
  });
  const issues = [...(Array.isArray(baseManifest['issues']) ? baseManifest['issues'] : []), ...engineIssues]
    .filter((entry, index, all) => all.findIndex((candidate) =>
      candidate?.code === entry?.code && candidate?.path === entry?.path && candidate?.reason === entry?.reason) === index);
  return {
    kind: 'scenario-instance',
    version: 1,
    manifest: {
      ...baseManifest,
      inputHash: generatedInputHash,
      instanceId: `${String(baseManifest['instanceId'])}@ambient:${provenance.profileHash.slice(0, 12)}`,
      actors,
      issues,
      ambientTraffic: normalizedProvenance,
      ambientBaseInputHash: provenance.baseInputHash,
    },
    input,
    ambientTraffic: normalizedProvenance,
  };
}
