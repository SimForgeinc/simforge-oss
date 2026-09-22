import type { ScenarioMapEntry } from "@simforge-oss/editor";

const DEFAULT_REASON = "SUMO is unavailable because this map has no SUMO road network.";

/**
 * The sentence the traffic panels show when SUMO cannot run on a map, taken
 * from the map revision's recorded SUMO state (a failed validation gate, a
 * build in progress, not yet built) instead of a generic absence message.
 * Null when the map carries a SUMO network.
 */
export function sumoUnavailableReason(
  map: Pick<ScenarioMapEntry, "sumoNetworkSha256" | "sumoStatus">,
): string | null {
  if (map.sumoNetworkSha256) return null;
  const status = map.sumoStatus;
  if (!status) return DEFAULT_REASON;
  if (status.state === "failed") {
    return `SUMO is unavailable: this map's SUMO road network failed validation${status.reason ? ` (${status.reason})` : ""}.`;
  }
  if (status.state === "building") return "SUMO is unavailable while this map's SUMO road network is being built.";
  return status.reason ? `SUMO is unavailable: ${status.reason}` : DEFAULT_REASON;
}
