/**
 * The transfer overlay's state, kept out of the component so the rules are
 * tested directly: which placements are selected, what each variation is
 * called, how a batch of creates runs, and how a partial failure reads.
 */

import type { ScenarioTransferCandidateDto } from "@simforge-oss/studio-host";

/** One placement: a site on a map. */
export type CandidateRef = {
  mapVersionId: string;
  mapLabel: string;
  candidate: ScenarioTransferCandidateDto;
};

export type MapSearch =
  | { status: "queued" }
  | { status: "searching" }
  | { status: "ready"; candidates: ScenarioTransferCandidateDto[] }
  | { status: "failed"; message: string; scope: "scenario" | "map" };

export type CreateJob =
  | { status: "queued" }
  | { status: "creating" }
  | { status: "created"; documentId: string; datasetId: string; title: string }
  | { status: "failed"; message: string };

export function candidateKey(mapVersionId: string, siteId: string): string {
  return `${mapVersionId}::${siteId}`;
}

export function toggleSelection(selection: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selection);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Selected placements, in the order they are shown: map by map, best first. */
export function selectedRefs(
  selection: ReadonlySet<string>,
  maps: ReadonlyArray<{ mapVersionId: string; label: string; search: MapSearch }>,
): CandidateRef[] {
  const out: CandidateRef[] = [];
  for (const map of maps) {
    if (map.search.status !== "ready") continue;
    for (const candidate of map.search.candidates) {
      if (selection.has(candidateKey(map.mapVersionId, candidate.siteId))) {
        out.push({ mapVersionId: map.mapVersionId, mapLabel: map.label, candidate });
      }
    }
  }
  return out;
}

const MAX_TITLE = 200;

/**
 * What each new variation is called: the source's name and the map it now
 * lives on, numbered only when one map gets more than one of them, so the
 * list reads "Merge · Yale Street" rather than five "Merge Variation"s.
 */
export function variationTitles(sourceTitle: string, refs: readonly CandidateRef[]): Map<string, string> {
  const perMap = new Map<string, CandidateRef[]>();
  for (const ref of refs) perMap.set(ref.mapVersionId, [...(perMap.get(ref.mapVersionId) ?? []), ref]);
  const titles = new Map<string, string>();
  const base = sourceTitle.trim() || "Scenario";
  for (const group of perMap.values()) {
    const ordered = [...group].sort((a, b) => a.candidate.rank - b.candidate.rank);
    ordered.forEach((ref, index) => {
      const suffix = ` · ${ref.mapLabel}${ordered.length > 1 ? ` ${index + 1}` : ""}`;
      const head = base.slice(0, Math.max(1, MAX_TITLE - suffix.length));
      titles.set(candidateKey(ref.mapVersionId, ref.candidate.siteId), `${head}${suffix}`);
    });
  }
  return titles;
}

export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * Run `work` over `items` with at most `concurrency` in flight, reporting each
 * start and each outcome. One failure never stops the others: a batch of
 * creates is independent documents, and the person needs to see which ones
 * made it. Resolves once every item has settled.
 */
export async function runBatch<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  options: {
    concurrency: number;
    onStart?: (item: T) => void;
    onSettled?: (item: T, result: Settled<R>) => void;
    isCancelled?: () => boolean;
  },
): Promise<Array<Settled<R>>> {
  const results: Array<Settled<R>> = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      if (options.isCancelled?.()) return;
      const index = next;
      next += 1;
      const item = items[index]!;
      options.onStart?.(item);
      let result: Settled<R>;
      try {
        result = { ok: true, value: await work(item) };
      } catch (error) {
        result = { ok: false, error };
      }
      results[index] = result;
      options.onSettled?.(item, result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, items.length)) }, lane));
  return results;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

export type BatchSummary = { total: number; created: number; failed: number; running: number };

export function batchSummary(jobs: ReadonlyMap<string, CreateJob>): BatchSummary {
  let created = 0;
  let failed = 0;
  let running = 0;
  for (const job of jobs.values()) {
    if (job.status === "created") created += 1;
    else if (job.status === "failed") failed += 1;
    else running += 1;
  }
  return { total: jobs.size, created, failed, running };
}

/** The footer's one line of status. */
export function statusLine(input: {
  phase: "choosing" | "creating" | "done";
  selected: number;
  searching: number;
  summary: BatchSummary;
}): string {
  if (input.phase === "creating") {
    const settled = input.summary.created + input.summary.failed;
    return `Creating ${Math.min(settled + 1, input.summary.total)} of ${input.summary.total}`;
  }
  if (input.phase === "done") {
    const { created, failed } = input.summary;
    const made = `${created} ${created === 1 ? "variation" : "variations"} created`;
    return failed > 0 ? `${made} · ${failed} failed` : made;
  }
  if (input.selected > 0) return `${input.selected} selected`;
  if (input.searching > 0) return `Searching ${input.searching} ${input.searching === 1 ? "map" : "maps"}`;
  return "Select placements";
}

/**
 * A failure that belongs to the scenario rather than to one map (it does not
 * compile anywhere): said once, as soon as the first map reports it, instead
 * of waiting for every other map to fail the same way.
 */
export function scenarioFailure(searches: readonly MapSearch[]): string | null {
  for (const search of searches) {
    if (search.status === "failed" && search.scope === "scenario") return search.message;
  }
  return null;
}

/** Placements the person has not yet created: what "Retry failed" reselects. */
export function failedKeys(jobs: ReadonlyMap<string, CreateJob>): Set<string> {
  return new Set([...jobs].filter(([, job]) => job.status === "failed").map(([key]) => key));
}
