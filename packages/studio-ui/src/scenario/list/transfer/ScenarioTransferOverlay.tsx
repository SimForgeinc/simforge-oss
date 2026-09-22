"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as stylex from "@stylexjs/stylex";
import { AlertTriangle, Check, CircleCheck, CircleX, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ScenarioDocumentDto,
  ScenarioTransferCandidateDto,
  ScenarioTransferOptionsDto,
} from "@simforge-oss/studio-host";
import type { ScenarioDocumentSummaryDto } from "../../../lib/scenario/contracts";
import { useStudioHost } from "../../../host";
import { CloudActivityIndicator } from "../../../components/CloudLoadingSurface";
import { SkyCloudBackdrop } from "../../../components/SkyCloudBackdrop";
import { Progress } from "../../../components/stylex";
import { Skeleton } from "../../../components/ui/skeleton";
import { documentName } from "../document-list-utils";
import { TransferPreview } from "./TransferPreview";
import {
  batchSummary,
  candidateKey,
  errorMessage,
  failedKeys,
  runBatch,
  scenarioFailure,
  selectedRefs,
  statusLine,
  toggleSelection,
  variationTitles,
  type CandidateRef,
  type CreateJob,
  type MapSearch,
} from "./transfer-model";
import { styles } from "./ScenarioTransferOverlay.stylex";

/** A map's search failed; `scope` says whether the scenario or only this map is to blame. */
class SearchFailure extends Error {
  constructor(message: string, readonly scope: "scenario" | "map") {
    super(message);
  }
}

/** Maps searched at once. Each search holds a whole map on the server while it runs. */
const SEARCH_CONCURRENCY = 2;
/** Variations created at once. */
const CREATE_CONCURRENCY = 2;

type Lift =
  | { status: "loading" }
  | { status: "refused"; issues: ScenarioTransferOptionsDto["lift"]["issues"] }
  | { status: "failed"; message: string }
  | { status: "ready" };

type MapRow = { mapVersionId: string; label: string; locality: string | null; search: MapSearch };

/**
 * Searches already answered this session, keyed by document revision and map:
 * reopening the overlay on the same scenario shows its placements at once.
 */
const searchCache = new Map<string, ScenarioTransferCandidateDto[]>();
function searchCacheKey(document: ScenarioDocumentSummaryDto, mapVersionId: string): string {
  return `${document.id}:${document.updatedAt}:${mapVersionId}`;
}

/**
 * Transfer a scenario to other maps.
 *
 * A full-screen surface, like the app switcher: every place this scenario can
 * be put on every other map, drawn as a plan of the road with the actors where
 * they will stand, grouped by map and filled in as each map's search returns.
 * Pick any number of them and create them in one go; each card then reports
 * its own outcome and links to the scenario it became.
 */
export function ScenarioTransferOverlay({
  document,
  onClose,
  onCreated,
  onOpenDocument,
}: {
  /** The scenario to transfer; the overlay is open while this is set. */
  document: ScenarioDocumentSummaryDto | null;
  onClose: () => void;
  /** A variation now exists; the caller adds it to the list. */
  onCreated: (source: ScenarioDocumentSummaryDto, created: ScenarioDocumentDto) => void;
  /** Open a created variation in the editor. */
  onOpenDocument: (created: ScenarioDocumentDto) => void;
}) {
  const studioHost = useStudioHost();
  const [lift, setLift] = useState<Lift>({ status: "loading" });
  const [maps, setMaps] = useState<MapRow[]>([]);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [jobs, setJobs] = useState<Map<string, CreateJob>>(() => new Map());
  const [phase, setPhase] = useState<"choosing" | "creating" | "done">("choosing");
  const createdDocuments = useRef(new Map<string, ScenarioDocumentDto>());
  const session = useRef(0);
  const scenarioFailed = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The row object can be replaced while the overlay is open (the list
  // refreshes as variations land); the session belongs to the document id.
  const documentRef = useRef(document);
  documentRef.current = document;
  const documentId = document?.id ?? null;

  const updateMap = useCallback((mapVersionId: string, search: MapSearch) => {
    setMaps((current) => current.map((map) => (map.mapVersionId === mapVersionId ? { ...map, search } : map)));
  }, []);

  const searchMaps = useCallback(
    async (source: ScenarioDocumentSummaryDto, rows: readonly MapRow[], token: number) => {
      await runBatch(
        rows,
        async (row) => {
          const cached = searchCache.get(searchCacheKey(source, row.mapVersionId));
          if (cached) return cached;
          const options = await studioHost.projects.getDocumentTransferOptions(source.id, {
            targetMapVersionIds: [row.mapVersionId],
          });
          const map = options.maps.find((entry) => entry.mapVersionId === row.mapVersionId);
          if (!map) throw new Error("This map is no longer published.");
          if (map.error) throw new SearchFailure(map.error, map.errorScope === "scenario" ? "scenario" : "map");
          const candidates = map.candidates ?? [];
          searchCache.set(searchCacheKey(source, row.mapVersionId), candidates);
          return candidates;
        },
        {
          concurrency: SEARCH_CONCURRENCY,
          // A failure that is the scenario's ends the search: every map would repeat it.
          isCancelled: () => session.current !== token || scenarioFailed.current,
          onStart: (row) => {
            if (session.current === token) updateMap(row.mapVersionId, { status: "searching" });
          },
          onSettled: (row, result) => {
            if (session.current !== token) return;
            if (!result.ok && result.error instanceof SearchFailure && result.error.scope === "scenario") {
              scenarioFailed.current = true;
            }
            updateMap(
              row.mapVersionId,
              result.ok
                ? { status: "ready", candidates: result.value }
                : {
                    status: "failed",
                    message: errorMessage(result.error, "This map could not be searched."),
                    scope: result.error instanceof SearchFailure ? result.error.scope : "map",
                  },
            );
          },
        },
      );
    },
    [studioHost, updateMap],
  );

  // Open: lift the scenario and list the maps, then search them a few at a time.
  useEffect(() => {
    const document = documentRef.current;
    if (!documentId || !document) return;
    const token = ++session.current;
    setLift({ status: "loading" });
    setMaps([]);
    setSelection(new Set());
    setJobs(new Map());
    setPhase("choosing");
    scenarioFailed.current = false;
    createdDocuments.current = new Map();
    void studioHost.projects.getDocumentTransferOptions(document.id, { candidates: false }).then(
      (options) => {
        if (session.current !== token) return;
        if (!options.lift.ok) {
          setLift({ status: "refused", issues: options.lift.issues });
          return;
        }
        const rows: MapRow[] = options.maps.map((map) => ({
          mapVersionId: map.mapVersionId,
          label: map.label,
          locality: map.locality,
          search: { status: "queued" },
        }));
        setLift({ status: "ready" });
        setMaps(rows);
        void searchMaps(document, rows, token);
      },
      (error: unknown) => {
        if (session.current === token) setLift({ status: "failed", message: errorMessage(error, "The scenario could not be read.") });
      },
    );
    return () => {
      // Closing abandons searches still running; their answers are dropped.
      if (session.current === token) session.current += 1;
    };
  }, [documentId, searchMaps, studioHost]);

  const refs = useMemo(
    () => selectedRefs(selection, maps.map((map) => ({ mapVersionId: map.mapVersionId, label: map.label, search: map.search }))),
    [maps, selection],
  );
  const summary = batchSummary(jobs);
  const searching = maps.filter((map) => map.search.status === "queued" || map.search.status === "searching").length;
  const found = maps.reduce((sum, map) => sum + (map.search.status === "ready" ? map.search.candidates.length : 0), 0);
  const allFailed = scenarioFailure(maps.map((map) => map.search));

  const createBatch = useCallback(
    async (batch: CandidateRef[]) => {
      if (!document || batch.length === 0) return;
      const token = session.current;
      const titles = variationTitles(documentName(document), batch);
      setPhase("creating");
      setJobs((current) => {
        const next = new Map(current);
        for (const ref of batch) next.set(candidateKey(ref.mapVersionId, ref.candidate.siteId), { status: "queued" });
        return next;
      });
      const setJob = (ref: CandidateRef, job: CreateJob) =>
        setJobs((current) => new Map(current).set(candidateKey(ref.mapVersionId, ref.candidate.siteId), job));
      await runBatch(
        batch,
        (ref) =>
          studioHost.projects.transferDocument(document.id, {
            targetMapVersionId: ref.mapVersionId,
            siteId: ref.candidate.siteId,
            title: titles.get(candidateKey(ref.mapVersionId, ref.candidate.siteId)),
          }),
        {
          concurrency: CREATE_CONCURRENCY,
          onStart: (ref) => setJob(ref, { status: "creating" }),
          onSettled: (ref, result) => {
            if (result.ok) {
              createdDocuments.current.set(candidateKey(ref.mapVersionId, ref.candidate.siteId), result.value);
              setJob(ref, {
                status: "created",
                documentId: result.value.id,
                datasetId: result.value.datasetId,
                title: result.value.title,
              });
              onCreated(document, result.value);
            } else {
              setJob(ref, { status: "failed", message: errorMessage(result.error, "The variation could not be created.") });
            }
          },
        },
      );
      if (session.current === token) setPhase("done");
    },
    [document, onCreated, studioHost],
  );

  const create = useCallback(() => {
    if (phase !== "choosing" || refs.length === 0) return;
    void createBatch(refs);
  }, [createBatch, phase, refs]);

  const retryFailed = useCallback(() => {
    const retry = failedKeys(jobs);
    const batch = selectedRefs(retry, maps.map((map) => ({ mapVersionId: map.mapVersionId, label: map.label, search: map.search })));
    void createBatch(batch);
  }, [createBatch, jobs, maps]);

  const retryMap = useCallback(
    (mapVersionId: string) => {
      if (!document) return;
      const row = maps.find((map) => map.mapVersionId === mapVersionId);
      if (!row) return;
      updateMap(mapVersionId, { status: "queued" });
      searchCache.delete(searchCacheKey(document, mapVersionId));
      void searchMaps(document, [row], session.current);
    },
    [document, maps, searchMaps, updateMap],
  );

  const toggle = useCallback(
    (key: string) => {
      if (phase !== "choosing") return;
      setSelection((current) => toggleSelection(current, key));
    },
    [phase],
  );

  const openCreated = useCallback(
    (key: string) => {
      const created = createdDocuments.current.get(key);
      if (!created) return;
      onClose();
      onOpenDocument(created);
    },
    [onClose, onOpenDocument],
  );

  const open = Boolean(document);
  const busy = phase === "creating";
  // Nothing to choose from: the bar offers only a way out.
  const choosable = lift.status === "ready" && !allFailed && (searching > 0 || found > 0);
  const title = document ? documentName(document) : "";

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay {...stylex.props(styles.backdrop)}>
          <SkyCloudBackdrop animated={false} />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          {...stylex.props(styles.dialog)}
          data-testid="scenario-transfer-overlay"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              create();
            }
          }}
          onOpenAutoFocus={(event) => {
            // Land on the list, not on the close button: the first Tab reaches
            // the first card, and Shift+Tab the close button.
            event.preventDefault();
            bodyRef.current?.focus({ preventScroll: true });
          }}
        >
          <div {...stylex.props(styles.column)}>
            <header {...stylex.props(styles.header)}>
              <div {...stylex.props(styles.heading)}>
                <span {...stylex.props(styles.eyebrow)}>Transfer to other maps</span>
                <DialogPrimitive.Title {...stylex.props(styles.title)}>{title}</DialogPrimitive.Title>
                <DialogPrimitive.Description {...stylex.props(styles.lede)}>
                  Choose where this scenario should also run. Each placement becomes its own variation.
                </DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close {...stylex.props(styles.close)} aria-label="Close transfer" disabled={busy}>
                <X {...stylex.props(styles.closeIcon)} aria-hidden="true" />
              </DialogPrimitive.Close>
            </header>

            <div ref={bodyRef} tabIndex={-1} {...stylex.props(styles.body)} data-testid="scenario-transfer-body">
              {lift.status === "loading" ? (
                <div {...stylex.props(styles.notice)}>
                  <CloudActivityIndicator label="Reading the scenario" />
                </div>
              ) : null}
              {lift.status === "failed" ? (
                <div role="alert" {...stylex.props(styles.notice)}>
                  <h3 {...stylex.props(styles.noticeTitle)}>The scenario could not be read</h3>
                  <p {...stylex.props(styles.noticeText)}>{lift.message}</p>
                </div>
              ) : null}
              {lift.status === "refused" ? <Refusal issues={lift.issues} /> : null}
              {lift.status === "ready" && maps.length === 0 ? (
                <div {...stylex.props(styles.notice)}>
                  <h3 {...stylex.props(styles.noticeTitle)}>No other maps</h3>
                  <p {...stylex.props(styles.noticeText)}>Publish another map to transfer this scenario to it.</p>
                </div>
              ) : null}
              {lift.status === "ready" && allFailed ? (
                <div role="alert" {...stylex.props(styles.notice)}>
                  <h3 {...stylex.props(styles.noticeTitle)}>This scenario cannot be transferred yet</h3>
                  <p {...stylex.props(styles.noticeText)}>
                    It does not compile, so no map can take it. Fix it in the editor, then transfer it.
                  </p>
                  <ul {...stylex.props(styles.noticeList)}>
                    <li>{allFailed}</li>
                  </ul>
                </div>
              ) : null}
              {lift.status === "ready" && !allFailed && searching === 0 && maps.length > 0 && found === 0 ? (
                <div {...stylex.props(styles.notice)}>
                  <h3 {...stylex.props(styles.noticeTitle)}>No placements found</h3>
                  <p {...stylex.props(styles.noticeText)}>
                    None of the other maps has a place where this scenario keeps its meaning.
                  </p>
                </div>
              ) : null}
              {lift.status === "ready" && !allFailed
                ? maps.map((map) => (
                    <MapSection
                      key={map.mapVersionId}
                      map={map}
                      selection={selection}
                      jobs={jobs}
                      phase={phase}
                      onToggle={toggle}
                      onRetry={retryMap}
                      onOpen={openCreated}
                    />
                  ))
                : null}
            </div>

            <footer {...stylex.props(styles.bar)}>
              <div {...stylex.props(styles.barStatus)}>
                {choosable && searching > 0 && phase === "choosing" && selection.size === 0 ? <CloudActivityIndicator /> : null}
                <span role="status" aria-live="polite" {...stylex.props(styles.barStatusText)}>
                  {choosable || phase !== "choosing" ? statusLine({ phase, selected: selection.size, searching, summary }) : null}
                </span>
                {busy ? (
                  <Progress
                    value={summary.total === 0 ? 0 : (summary.created + summary.failed) / summary.total}
                    size="sm"
                    xstyle={styles.barProgress}
                    aria-label="Creating variations"
                  />
                ) : null}
              </div>
              <div {...stylex.props(styles.barActions)}>
                {phase === "choosing" && !choosable ? (
                  <button type="button" {...stylex.props(styles.barButton, styles.barButtonQuiet)} onClick={onClose}>
                    Close
                  </button>
                ) : null}
                {phase === "choosing" && choosable ? (
                  <>
                    {selection.size > 0 ? (
                      <button type="button" {...stylex.props(styles.barButton, styles.barButtonQuiet)} onClick={() => setSelection(new Set())}>
                        Clear
                      </button>
                    ) : null}
                    <button type="button" {...stylex.props(styles.barButton, styles.barButtonQuiet)} onClick={onClose}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      data-testid="scenario-transfer-create"
                      disabled={refs.length === 0}
                      {...stylex.props(styles.barButton, styles.barButtonPrimary)}
                      onClick={create}
                    >
                      {refs.length > 1 ? `Create ${refs.length} variations` : "Create variation"}
                      <span {...stylex.props(styles.keyHint)} aria-hidden="true">{shortcutHint()}</span>
                    </button>
                  </>
                ) : null}
                {phase === "creating" ? (
                  <button type="button" disabled {...stylex.props(styles.barButton, styles.barButtonPrimary)}>
                    Creating…
                  </button>
                ) : null}
                {phase === "done" ? (
                  <>
                    {summary.failed > 0 ? (
                      <button type="button" {...stylex.props(styles.barButton, styles.barButtonQuiet)} onClick={retryFailed}>
                        <RotateCcw {...stylex.props(styles.barIcon)} aria-hidden="true" />
                        Retry failed
                      </button>
                    ) : null}
                    <button type="button" data-testid="scenario-transfer-done" {...stylex.props(styles.barButton, styles.barButtonPrimary)} onClick={onClose}>
                      Done
                    </button>
                  </>
                ) : null}
              </div>
            </footer>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The create shortcut as this platform writes it. */
function shortcutHint(): string {
  if (typeof navigator === "undefined") return "Ctrl ↵";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘↵" : "Ctrl ↵";
}

/** Plain words for the refusals a person can act on; anything else shows the compiler's own. */
const REFUSAL_COPY: Record<string, string> = {
  reference_role_missing: "It has no actor placed on the map, so there is nothing to carry to another one.",
  reference_lane_anchor_missing: "Its measured actor is not snapped to a lane. Snap it to a lane in the editor, then transfer.",
  reference_lane_missing: "Its measured actor sits on a lane this map version no longer has. Re-snap it in the editor.",
  source_frame_unbuildable: "The road around its measured actor could not be read as a junction or a corridor.",
  source_map_unavailable: "Its map is not in the published catalog any more.",
};

function Refusal({ issues }: { issues: ScenarioTransferOptionsDto["lift"]["issues"] }) {
  const errors = issues.filter((issue) => issue.severity === "error");
  const shown = errors.length > 0 ? errors : issues;
  const first = shown[0];
  const plain = first ? REFUSAL_COPY[first.code] : undefined;
  const details = [...(plain && first ? [first] : []), ...shown.slice(1)].slice(0, 5);
  return (
    <div role="alert" {...stylex.props(styles.notice)}>
      <h3 {...stylex.props(styles.noticeTitle)}>This scenario cannot be transferred</h3>
      <p {...stylex.props(styles.noticeText)}>{plain ?? first?.message ?? "It has nothing to anchor a placement on another map to."}</p>
      {details.length > 0 ? (
        <ul {...stylex.props(styles.noticeList)}>
          {details.map((issue, index) => (
            <li key={`${issue.code}:${issue.path ?? index}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MapSection({
  map,
  selection,
  jobs,
  phase,
  onToggle,
  onRetry,
  onOpen,
}: {
  map: MapRow;
  selection: ReadonlySet<string>;
  jobs: ReadonlyMap<string, CreateJob>;
  phase: "choosing" | "creating" | "done";
  onToggle: (key: string) => void;
  onRetry: (mapVersionId: string) => void;
  onOpen: (key: string) => void;
}) {
  const headingId = `transfer-map-${map.mapVersionId}`;
  const { search } = map;
  return (
    <section aria-labelledby={headingId} {...stylex.props(styles.section)} data-testid="scenario-transfer-map">
      <div {...stylex.props(styles.sectionHead)}>
        <h3 id={headingId} {...stylex.props(styles.sectionTitle)}>
          {map.label}
        </h3>
        <span {...stylex.props(styles.sectionStatus)}>
          {search.status === "queued" ? "Waiting" : null}
          {search.status === "searching" ? <CloudActivityIndicator label="Searching" /> : null}
          {search.status === "ready"
            ? search.candidates.length === 0
              ? "No placement fits"
              : `${search.candidates.length} ${search.candidates.length === 1 ? "placement" : "placements"}`
            : null}
          {search.status === "failed" ? (
            <>
              <span {...stylex.props(styles.sectionError)}>{search.message}</span>
              {phase === "choosing" ? (
                <button type="button" {...stylex.props(styles.inlineAction)} onClick={() => onRetry(map.mapVersionId)}>
                  Retry
                </button>
              ) : null}
            </>
          ) : null}
        </span>
      </div>
      {search.status === "queued" || search.status === "searching" ? (
        <div {...stylex.props(styles.grid)} aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} {...stylex.props(styles.skeletonCard)}>
              <Skeleton xstyle={styles.skeletonStage} />
              <Skeleton xstyle={styles.skeletonLine} />
            </div>
          ))}
        </div>
      ) : null}
      {search.status === "ready" && search.candidates.length > 0 ? (
        <div {...stylex.props(styles.grid)}>
          {search.candidates.map((candidate) => {
            const key = candidateKey(map.mapVersionId, candidate.siteId);
            return (
              <PlacementCard
                key={key}
                mapLabel={map.label}
                candidate={candidate}
                selected={selection.has(key)}
                job={jobs.get(key) ?? null}
                phase={phase}
                onToggle={() => onToggle(key)}
                onOpen={() => onOpen(key)}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function PlacementCard({
  mapLabel,
  candidate,
  selected,
  job,
  phase,
  onToggle,
  onOpen,
}: {
  mapLabel: string;
  candidate: ScenarioTransferCandidateDto;
  selected: boolean;
  job: CreateJob | null;
  phase: "choosing" | "creating" | "done";
  onToggle: () => void;
  onOpen: () => void;
}) {
  const choosing = phase === "choosing";
  const inert = !choosing && !job;
  const verdict = candidate.verdict === "exact" ? "Exact" : "Adapted";
  const warning = candidate.offRoadActors > 0
    ? `${candidate.offRoadActors} ${candidate.offRoadActors === 1 ? "actor" : "actors"} off road`
    : null;
  const label = [
    `Placement ${candidate.rank} on ${mapLabel}`,
    candidate.verdict === "exact" ? "exact match" : `adapted: ${candidate.summary}`,
    warning,
  ].filter(Boolean).join(", ");
  return (
    <div
      // A choice while choosing; afterwards a labelled result holding its own link.
      role={choosing ? "checkbox" : "group"}
      aria-checked={choosing ? selected : undefined}
      aria-label={label}
      tabIndex={choosing ? 0 : -1}
      title={candidate.summary || undefined}
      data-testid="scenario-transfer-candidate"
      data-selected={selected ? "true" : "false"}
      data-job={job?.status ?? "none"}
      {...stylex.props(
        styles.card,
        selected ? styles.cardSelected : styles.cardIdle,
        !choosing && (job ? styles.cardLocked : styles.cardInert),
      )}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) return;
        onToggle();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === " " || (event.key === "Enter" && !event.metaKey && !event.ctrlKey)) {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <div {...stylex.props(styles.stage, !candidate.preview && styles.stageEmpty, inert && styles.inertContent)}>
        {candidate.preview ? <TransferPreview preview={candidate.preview} /> : "No preview"}
        {choosing || selected ? (
          <span {...stylex.props(styles.check, selected && styles.checkOn)} aria-hidden="true">
            {selected ? <Check {...stylex.props(styles.checkIcon)} /> : null}
          </span>
        ) : null}
        {job ? <JobStatus job={job} onOpen={onOpen} /> : null}
      </div>
      <div {...stylex.props(styles.cardBody, inert && styles.inertContent)}>
        <span {...stylex.props(styles.cardName)}>Placement {candidate.rank}</span>
        <span {...stylex.props(styles.cardMeta, warning ? styles.cardWarn : null)}>
          {warning ? <AlertTriangle {...stylex.props(styles.jobIcon)} aria-hidden="true" /> : null}
          <span {...stylex.props(styles.jobMessage)}>{warning ?? verdict}</span>
        </span>
      </div>
    </div>
  );
}

function JobStatus({ job, onOpen }: { job: CreateJob; onOpen: () => void }) {
  if (job.status === "queued") {
    return (
      <div {...stylex.props(styles.job)}>
        <span {...stylex.props(styles.jobState)}>Queued</span>
      </div>
    );
  }
  if (job.status === "creating") {
    return (
      <div {...stylex.props(styles.job)}>
        <CloudActivityIndicator label="Creating" />
      </div>
    );
  }
  if (job.status === "created") {
    const href = `/dashboard/scenario?dataset=${encodeURIComponent(job.datasetId)}&document=${encodeURIComponent(job.documentId)}`;
    return (
      <div {...stylex.props(styles.job)}>
        <span {...stylex.props(styles.jobState, styles.jobDone)}>
          <CircleCheck {...stylex.props(styles.jobIcon)} aria-hidden="true" />
          <span {...stylex.props(styles.jobMessage)}>Created</span>
        </span>
        <a
          href={href}
          {...stylex.props(styles.openLink)}
          data-testid="scenario-transfer-open"
          aria-label={`Open ${job.title}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            onOpen();
          }}
        >
          Open
        </a>
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.job)} role="alert">
      <span {...stylex.props(styles.jobState, styles.jobFailed)} title={job.message}>
        <CircleX {...stylex.props(styles.jobIcon)} aria-hidden="true" />
        <span {...stylex.props(styles.jobMessage)}>{job.message}</span>
      </span>
    </div>
  );
}
