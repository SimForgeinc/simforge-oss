import type {
  RevisionSimulationReason,
  ScenarioVersionActorDto,
  ScenarioVersionCreatedFor,
  ScenarioVersionDto,
  ScenarioVersionSimulationDto,
  ScenarioVersionsDto,
  SimulationMotionDiffDto,
} from "@simforge-oss/studio-host";

/**
 * What the Versions panel says. A user sees exactly three version concepts:
 * "Version N" (a saved revision), "Engine x.y.z" (which engine produced a
 * simulation) and "<Map name> · <date>" (the map publication it runs on).
 * Every other identifier (sim key, trace and timeline digests, builds) is
 * behind Details.
 */

const CREATED_FOR: Record<ScenarioVersionCreatedFor, string> = {
  render: "Saved for render",
  save: "Saved version",
  engine_upgrade: "Kept previous motion",
  import: "Imported",
  map_move: "Before moving to another map version",
};

const REASON: Record<RevisionSimulationReason, string> = {
  commit: "Authored",
  engine_upgrade: "Kept from engine upgrade",
  resimulate: "Re-simulated",
  import: "Imported",
  backfill: "Re-simulated earlier",
};

export function versionTitle(version: Pick<ScenarioVersionDto, "revisionNumber">): string {
  return `Version ${version.revisionNumber}`;
}

export function engineLabel(engineSemVer: string): string {
  return `Engine ${engineSemVer}`;
}

export function createdForLabel(createdFor: ScenarioVersionCreatedFor): string {
  return CREATED_FOR[createdFor];
}

export function reasonLabel(reason: RevisionSimulationReason): string {
  return REASON[reason];
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "Sep 23": a date the way the panel shows it; empty for an unparseable value. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? "" : DATE.format(date);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? "" : DATE_TIME.format(date);
}

export function actorName(actor: ScenarioVersionActorDto): string {
  return actor?.name?.trim() || (actor ? "A teammate" : "SimForge");
}

/** "Richmond Field Station · Sep 20". */
export function mapLabel(map: ScenarioVersionDto["map"]): string {
  if (!map) return "No map";
  const date = shortDate(map.publishedAt);
  return date ? `${map.name} · ${date}` : map.name;
}

/** "Version 3 · Sep 23 · Michael · Saved for render". */
export function versionSummary(version: ScenarioVersionDto): string {
  return [versionTitle(version), shortDate(version.createdAt), actorName(version.createdBy), createdForLabel(version.createdFor)]
    .filter(Boolean)
    .join(" · ");
}

/** "Engine 0.9.0 · Sep 21 · Michael · Authored". */
export function simulationSummary(simulation: ScenarioVersionSimulationDto): string {
  return [engineLabel(simulation.engineSemVer), shortDate(simulation.createdAt), actorName(simulation.createdBy), reasonLabel(simulation.reason)]
    .filter(Boolean)
    .join(" · ");
}

export type DiffChipModel = { readonly text: string; readonly tone: "positive" | "warning" | "muted"; readonly title: string };

/** The chip beside a simulation: what changed against the entry it was compared with. */
export function diffChip(diff: SimulationMotionDiffDto | null, hasPrevious: boolean): DiffChipModel | null {
  if (!diff) {
    return hasPrevious
      ? { text: "Not compared yet", tone: "muted", title: "The comparison with the previous simulation has not been computed." }
      : null;
  }
  if (diff.identical) {
    return { text: "Motion identical", tone: "positive", title: "Every actor stays within 1 mm and 0.05° of the previous simulation, with the same events." };
  }
  const worst = diff.worst ? ` Largest change: ${diff.worst.actorId} at ${diff.worst.tS.toFixed(2)} s.` : "";
  return { text: diff.summary, tone: "warning", title: `Changed against the previous simulation.${worst}` };
}

/** The simulation a version's renders replay, if any. */
export function activeSimulation(version: ScenarioVersionDto): ScenarioVersionSimulationDto | null {
  return version.simulations.find((simulation) => simulation.active) ?? null;
}

/** True when the version has no simulation under the engine this host runs now. */
export function canResimulate(version: ScenarioVersionDto, currentEngineSemVer: string): boolean {
  return !version.simulations.some((simulation) => simulation.engineSemVer === currentEngineSemVer);
}

/** A short digest for Details (full value on hover). */
export function shortDigest(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "none";
}

/** The panel's headline: how many versions, and whether the draft matches one of them. */
export function panelSubtitle(versions: ScenarioVersionsDto): string {
  const count = versions.versions.length;
  if (count === 0) return "No saved versions yet. Save one to keep this state of the scenario.";
  const matching = versions.versions.find((version) => version.matchesDraft);
  const counted = `${count} ${count === 1 ? "version" : "versions"}`;
  return matching ? `${counted} · the draft matches ${versionTitle(matching)}` : `${counted} · the draft has changes since the last version`;
}
