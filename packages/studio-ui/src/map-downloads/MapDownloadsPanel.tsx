"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  AlertTriangle,
  CarFront,
  Check,
  CircleAlert,
  Download,
  Flag,
  HardDrive,
  Info,
  Lock,
  Pause,
  Play,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Chip } from "../components/ui/chip";
import { Dot } from "../components/ui/dot";
import { IconButton } from "../components/ui/icon-button";
import { MetaLabel } from "../components/stylex/MetaLabel";
import {
  DEFAULT_RENDERING_PREFERENCE,
  RENDERING_PREFERENCE_CHOICES,
  saveRenderingPreference,
  useRenderingPreference,
  type RenderingPreference,
} from "../components/rendering-preference";
import { focus, hairline, interactive, motionRecipe, textLayout, typography } from "../stylex/recipes.stylex";
import {
  clearMapAssetCache,
  deleteMapAssetDigests,
  mapAssetCacheStatus,
  onMapAssetCacheChange,
  prepareMapAssetCache,
  setMapAssetCacheBudget,
  type MapAssetCacheBudgetSetting,
  type MapAssetCacheStatus,
} from "../lib/maps/frontend/map-asset-cache";
import { loadMapDownloadPlans, planResidency, type MapDownloadPlanOutcome } from "../lib/maps/frontend/map-download-loader";
import {
  assessMapDownloadCapacity,
  formatDownloadBytes,
  type MapDownloadMapProgress,
  type MapDownloadSnapshot,
} from "../lib/maps/frontend/map-download-manager";
import type { MapDownloadPlan } from "../lib/maps/frontend/map-download-plan";
import { getMapDownloadManager, useMapDownloads } from "../lib/maps/frontend/map-downloads";
import { MapDownloadCity } from "./MapDownloadCity";
import { mergeStyleProps } from "../components/stylex/surface";
import { styles, tileMarker } from "./MapDownloadsPanel.stylex";

/**
 * Map downloads: pick maps and a render setting, see what they cost against
 * this browser's map cache, and download them — watching each map's city
 * build itself block by block as its files arrive.
 *
 * Shown inline in the app switcher (and as the first thing a person sees on
 * their first sign-in). The download itself belongs to the page, not to this
 * panel (`map-downloads.ts`): closing the panel or navigating keeps it going,
 * and a reload resumes it.
 *
 * Props only for the catalog; the host fetches it.
 */

export type MapDownloadsCatalogMap = {
  mapVersionId: string;
  label: string;
  locality: string | null;
  thumbnailUrl: string | null;
  /** Listed, but this account cannot open it. */
  locked: boolean;
};

const GIB = 1024 ** 3;
const PRESETS: ReadonlyArray<{ label: string; setting: MapAssetCacheBudgetSetting }> = [
  { label: "8 GB", setting: { kind: "bytes", bytes: 8 * GIB } },
  { label: "16 GB", setting: { kind: "bytes", bytes: 16 * GIB } },
  { label: "32 GB", setting: { kind: "bytes", bytes: 32 * GIB } },
];
const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 20;
/** A map counts as partly here only past this share; planning documents alone do not. */
const PARTIAL_SHARE = 0.1;

type Residency = { residentBytes: number; lit: ReadonlySet<string> };

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 1) return "a moment";
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function busy(job: MapDownloadSnapshot | null): boolean {
  return job?.status === "planning" || job?.status === "downloading" || job?.status === "paused";
}

export function MapDownloadsPanel({
  maps,
  loading,
  error,
  onRetry,
  firstRun = false,
}: {
  maps: readonly MapDownloadsCatalogMap[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  /** Opened on the person's first sign-in: say hello, and why. */
  firstRun?: boolean;
}) {
  const job = useMapDownloads();
  const saved = useRenderingPreference();
  const jobBusy = busy(job);
  const preference: RenderingPreference = jobBusy && job?.preference ? job.preference : saved ?? DEFAULT_RENDERING_PREFERENCE;

  // ── Plans at the chosen setting (sizes recompute live when it changes) ──
  const ids = useMemo(() => maps.filter((map) => !map.locked).map((map) => map.mapVersionId), [maps]);
  const idsKey = ids.join("|");
  const [plans, setPlans] = useState<{ preference: RenderingPreference; outcomes: ReadonlyMap<string, MapDownloadPlanOutcome> }>(
    { preference, outcomes: new Map() },
  );
  const [planError, setPlanError] = useState<string | null>(null);
  useEffect(() => {
    if (ids.length === 0) return;
    const controller = new AbortController();
    setPlans({ preference, outcomes: new Map() });
    setPlanError(null);
    loadMapDownloadPlans(ids, preference, {
      signal: controller.signal,
      onPlan: (outcome) => {
        if (controller.signal.aborted) return;
        setPlans((current) => current.preference === preference
          ? { preference, outcomes: new Map(current.outcomes).set(outcome.mapVersionId, outcome) }
          : current);
      },
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setPlanError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
    // `ids` is keyed by its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, preference]);
  const outcomes = plans.preference === preference ? plans.outcomes : NO_OUTCOMES;
  const planOf = useCallback((id: string): MapDownloadPlan | null => {
    const outcome = outcomes.get(id);
    return outcome?.ok ? outcome.plan : null;
  }, [outcomes]);

  // ── Background size of the other Low setting: same documents, no extra transfer ──
  const [siblingTotals, setSiblingTotals] = useState<Partial<Record<RenderingPreference, ReadonlyMap<string, number>>>>({});
  useEffect(() => {
    if (preference === "medium" || ids.length === 0) return;
    const sibling: RenderingPreference = preference === "low" ? "low-no-foliage" : "low";
    const controller = new AbortController();
    void loadMapDownloadPlans(ids, sibling, { signal: controller.signal }).then((list) => {
      if (controller.signal.aborted) return;
      setSiblingTotals((current) => ({
        ...current,
        [sibling]: new Map(list.flatMap((outcome) => (outcome.ok ? [[outcome.mapVersionId, outcome.plan.totalBytes] as const] : []))),
      }));
    }).catch(() => undefined);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, preference]);

  // ── Cache status and what is already resident ──
  const [cache, setCache] = useState<MapAssetCacheStatus | null>(null);
  const [cacheTick, setCacheTick] = useState(0);
  const refreshCache = useCallback(() => setCacheTick((tick) => tick + 1), []);
  useEffect(() => {
    let cancelled = false;
    void mapAssetCacheStatus().then((status) => { if (!cancelled) setCache(status); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cacheTick, job?.status]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onMapAssetCacheChange(() => {
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; refreshCache(); }, 1000);
    });
    return () => { unsubscribe(); if (timer !== null) clearTimeout(timer); };
  }, [refreshCache]);

  const [residency, setResidency] = useState<ReadonlyMap<string, Residency>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = new Map<string, Residency>();
      for (const [id, outcome] of outcomes) {
        if (!outcome.ok) continue;
        next.set(id, await planResidency(outcome.plan));
      }
      if (!cancelled) setResidency(next);
    })();
    return () => { cancelled = true; };
  }, [outcomes, cacheTick, job?.status]);

  // ── Selection: every available map unless the person unticked it ──
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const selectable = maps.filter((map) => !map.locked && outcomes.get(map.mapVersionId)?.ok !== false);
  const selected = selectable.filter((map) => !deselected.has(map.mapVersionId));
  const allSelected = selectable.length > 0 && selected.length === selectable.length;
  const toggle = (id: string) => setDeselected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setDeselected(allSelected ? new Set(selectable.map((map) => map.mapVersionId)) : new Set());

  const sizing = selected.some((map) => !outcomes.has(map.mapVersionId));
  const selectionBytes = selected.reduce((total, map) => total + (planOf(map.mapVersionId)?.totalBytes ?? 0), 0);
  const residentOfSelection = selected.reduce((total, map) => total + (residency.get(map.mapVersionId)?.residentBytes ?? 0), 0);
  const missingBytes = Math.max(0, selectionBytes - residentOfSelection);
  const browserCache = cache?.backend === "browser" ? cache : null;
  const capacity = browserCache && !browserCache.unavailable
    ? {
        ceilingBytes: browserCache.budgetBytes,
        originFreeBytes: browserCache.quotaBytes !== null && browserCache.usedBytes !== null
          ? Math.max(0, browserCache.quotaBytes - browserCache.usedBytes) : null,
      }
    : null;
  const verdict = capacity
    ? assessMapDownloadCapacity({ selectionBytes, missingBytes, cachedBytes: browserCache?.mapBytes ?? 0, capacity })
    : null;
  const failedPlans = [...outcomes.values()].filter((outcome): outcome is Extract<MapDownloadPlanOutcome, { ok: false }> => !outcome.ok);
  const onDevice = selectable.filter((map) => {
    const plan = planOf(map.mapVersionId);
    return plan !== null && (residency.get(map.mapVersionId)?.residentBytes ?? 0) >= plan.totalBytes;
  });

  // ── Actions ──
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const download = async () => {
    // First, inside the click: persistence may prompt, and a prompt needs the gesture.
    const persistence = prepareMapAssetCache();
    setStarting(true);
    setStartError(null);
    try {
      await persistence;
      const status = await mapAssetCacheStatus();
      setCache(status);
      if (status.backend === "browser") {
        if (status.unavailable) throw new Error(`Maps cannot be downloaded in this browser: ${status.unavailable}`);
        const fresh = assessMapDownloadCapacity({
          selectionBytes,
          missingBytes,
          cachedBytes: status.mapBytes,
          capacity: {
            ceilingBytes: status.budgetBytes,
            originFreeBytes: status.quotaBytes !== null && status.usedBytes !== null ? Math.max(0, status.quotaBytes - status.usedBytes) : null,
          },
        });
        if (!fresh.fits) throw new Error(fresh.reason);
      }
      const plansForJob = new Map(selected.flatMap((map) => {
        const plan = planOf(map.mapVersionId);
        return plan ? [[map.mapVersionId, plan] as const] : [];
      }));
      void getMapDownloadManager().start({
        preference,
        maps: selected.map((map) => ({ mapVersionId: map.mapVersionId, label: map.label })),
        plans: plansForJob,
      });
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarting(false);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const deleteMap = async (id: string) => {
    const plan = planOf(id);
    setConfirmDelete(null);
    if (!plan) return;
    // Content another resident map also uses stays.
    const kept = new Set<string>();
    for (const [otherId, outcome] of outcomes) {
      if (otherId === id || !outcome.ok || (residency.get(otherId)?.residentBytes ?? 0) === 0) continue;
      for (const asset of outcome.plan.assets) kept.add(asset.sha256);
    }
    try {
      await deleteMapAssetDigests(plan.assets.map((asset) => asset.sha256).filter((sha) => !kept.has(sha)));
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : String(reason));
    }
    refreshCache();
  };

  const labelOf = (id: string) => maps.find((map) => map.mapVersionId === id)?.label ?? id;
  const jobMap = (id: string): MapDownloadMapProgress | null =>
    job && job.status !== "idle" ? job.maps.find((map) => map.mapVersionId === id) ?? null : null;

  // ── The stage: the map being built, or the one the pointer is on ──
  const [focusId, setFocusId] = useState<string | null>(null);
  const stageMap = (() => {
    if (job && job.status !== "idle" && job.maps.length > 0) {
      const building = job.maps.find((map) => map.state === "downloading")
        ?? [...job.maps].reverse().find((map) => map.state === "done")
        ?? job.maps[0]!;
      return { id: building.mapVersionId, plan: building.plan, lit: new Set(building.litCells), active: building.activeCell, progress: building };
    }
    const id = focusId ?? selected.find((map) => planOf(map.mapVersionId))?.mapVersionId ?? null;
    if (!id) return null;
    return { id, plan: planOf(id), lit: residency.get(id)?.lit ?? new Set<string>(), active: null, progress: null };
  })();

  const jobFraction = job && job.totalBytes > 0 ? job.doneBytes / job.totalBytes : 0;
  const idleFraction = selectionBytes > 0 ? residentOfSelection / selectionBytes : 0;
  const roadFraction = job && job.status !== "idle" ? jobFraction : idleFraction;
  const complete = job?.status === "complete";

  return (
    <div {...stylex.props(styles.root)} data-testid="map-downloads-panel" data-first-run={firstRun ? "true" : "false"} data-job-status={job?.status ?? "idle"}>
      <div {...stylex.props(styles.scroller)}>
        <header {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.headerText)}>
            <p {...stylex.props(typography.eyebrow, styles.title)}>{firstRun ? "Welcome to SimForge" : "Map downloads"}</p>
            <h2 {...stylex.props(typography.heading, styles.title)}>
              {firstRun ? "Download your maps before you start" : "Maps on this device"}
            </h2>
            <p {...stylex.props(typography.body, styles.lede)}>
              {firstRun
                ? "Maps open instantly once they are in this browser. Pick the maps and the graphics you want; the download keeps going while you work, and you can come back here from the app switcher any time."
                : "Download maps into this browser once; the editor, the viewer and driving read them from here instead of the network."}
            </p>
          </div>
          <div {...stylex.props(styles.headerStats)}>
            <Chip tone={onDevice.length > 0 ? "positive" : "neutral"} leading={<Dot tone={onDevice.length > 0 ? "positive" : "muted"} />} data-testid="map-downloads-on-device">
              {onDevice.length} of {selectable.length} maps here
            </Chip>
            {browserCache && !browserCache.unavailable ? (
              <Chip tone="neutral" leading={<HardDrive {...stylex.props(styles.icon)} aria-hidden="true" />}>
                {formatDownloadBytes(browserCache.mapBytes)} cached
              </Chip>
            ) : null}
          </div>
        </header>

        <div {...stylex.props(styles.top)}>
          <Stage
            job={job}
            stage={stageMap}
            label={stageMap ? labelOf(stageMap.id) : null}
            roadFraction={roadFraction}
            complete={complete}
            selectedCount={selected.length}
            selectionBytes={selectionBytes}
            missingBytes={missingBytes}
            sizing={sizing}
            preference={preference}
          />
          <div {...stylex.props(styles.side)}>
            <section {...stylex.props(hairline.all, styles.section)} aria-labelledby="map-downloads-setting">
              <div {...stylex.props(styles.sectionHead)}>
                <h3 id="map-downloads-setting" {...stylex.props(typography.eyebrow, styles.title)}>Render setting</h3>
                {jobBusy ? <MetaLabel>Locked while downloading</MetaLabel> : null}
              </div>
              <div {...stylex.props(styles.choices)} role="radiogroup" aria-label="Render setting">
                {RENDERING_PREFERENCE_CHOICES.map((choice) => {
                  const current = choice.id === preference;
                  const total = current
                    ? (sizing ? null : selectionBytes)
                    : sumFor(siblingTotals[choice.id], selected.map((map) => map.mapVersionId));
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      role="radio"
                      aria-checked={current}
                      disabled={jobBusy}
                      title={choice.description}
                      onClick={() => saveRenderingPreference(choice.id)}
                      data-testid="map-downloads-setting"
                      data-setting={choice.id}
                      {...stylex.props(focus.ring, interactive.base, hairline.all, styles.choice, current && styles.choiceCurrent)}
                    >
                      <span {...stylex.props(styles.choiceName)}>{choice.label}</span>
                      <span {...stylex.props(typography.meta, styles.choiceSize, current && styles.choiceSizeCurrent)}>
                        {total === null ? (current ? "Sizing…" : choice.id === "medium" ? "Sharper · larger" : "—") : formatDownloadBytes(total)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
            <CacheSection
              cache={browserCache}
              missingBytes={missingBytes}
              verdict={verdict}
              locked={jobBusy}
              onChanged={refreshCache}
            />
          </div>
        </div>

        {planError ? <Notice tone="critical" testId="map-downloads-plan-error">{planError}</Notice> : null}
        {failedPlans.length > 0 ? (
          <Notice tone="warning" testId="map-downloads-unavailable">
            {failedPlans.length === 1 ? "1 map can't be downloaded" : `${failedPlans.length} maps can't be downloaded`}:{" "}
            {failedPlans.map((outcome) => `${labelOf(outcome.mapVersionId)} (${outcome.reason})`).join("; ")}
          </Notice>
        ) : null}
        {verdict && !verdict.fits ? <Notice tone="critical" testId="map-downloads-capacity">{verdict.reason}</Notice> : null}
        {verdict?.fits && verdict.evictsBytes > 0 && !jobBusy ? (
          <Notice tone="warning" testId="map-downloads-evicts">
            To make room, about {formatDownloadBytes(verdict.evictsBytes)} of older map files you did not select will be removed from the cache, least recently used first.
          </Notice>
        ) : null}
        {startError ? <Notice tone="critical" testId="map-downloads-start-error">{startError}</Notice> : null}
        {job?.error && (job.status === "failed") ? <Notice tone="critical" testId="map-downloads-job-error">{job.error}</Notice> : null}
        {cache?.backend === "browser" && cache.unavailable ? (
          <Notice tone="critical" testId="map-downloads-cache-unavailable">Maps cannot be downloaded here: {cache.unavailable}</Notice>
        ) : null}

        <section aria-labelledby="map-downloads-maps" {...stylex.props(styles.side)}>
          <div {...stylex.props(styles.mapsHead)}>
            <h3 id="map-downloads-maps" {...stylex.props(typography.eyebrow, styles.title)}>
              Maps · {selected.length} of {selectable.length} selected
            </h3>
            <div {...stylex.props(styles.mapsHeadActions)}>
              <Button
                size="sm"
                variant={allSelected ? "accentOutline" : "outline"}
                onClick={toggleAll}
                disabled={jobBusy || selectable.length === 0}
                data-testid="map-downloads-all"
                aria-pressed={allSelected}
              >
                {allSelected ? <Check aria-hidden="true" /> : null}
                All maps
              </Button>
            </div>
          </div>
          {error ? <Notice tone="critical" testId="map-downloads-catalog-error">{error}{onRetry ? " " : null}{onRetry ? <Button size="xs" variant="outline" onClick={onRetry}>Retry</Button> : null}</Notice> : null}
          {loading && maps.length === 0 ? (
            <p {...stylex.props(typography.body, motionRecipe.pulse)}>Loading the map catalog…</p>
          ) : null}
          {!loading && !error && maps.length === 0 ? (
            <p {...stylex.props(typography.body)}>No maps are published to this workspace yet.</p>
          ) : null}
          <div {...stylex.props(styles.tiles)} data-testid="map-downloads-tiles">
            {maps.map((map) => {
              const outcome = outcomes.get(map.mapVersionId);
              const plan = outcome?.ok ? outcome.plan : null;
              const live = jobMap(map.mapVersionId);
              const resident = residency.get(map.mapVersionId);
              return (
                <MapTile
                  key={map.mapVersionId}
                  map={map}
                  plan={plan}
                  reason={outcome && !outcome.ok ? outcome.reason : null}
                  selected={!deselected.has(map.mapVersionId) && !map.locked && outcome?.ok !== false}
                  locked={jobBusy}
                  live={live}
                  residentBytes={live && jobBusy ? live.doneBytes : resident?.residentBytes ?? 0}
                  lit={live && live.plan ? new Set(live.litCells) : resident?.lit ?? EMPTY}
                  activeCell={live?.activeCell ?? null}
                  confirmingDelete={confirmDelete === map.mapVersionId}
                  onToggle={() => toggle(map.mapVersionId)}
                  onFocus={() => setFocusId(map.mapVersionId)}
                  onDelete={() => setConfirmDelete(map.mapVersionId)}
                  onConfirmDelete={() => void deleteMap(map.mapVersionId)}
                  onCancelDelete={() => setConfirmDelete(null)}
                />
              );
            })}
          </div>
        </section>
      </div>

      <ActionBar
        job={job}
        starting={starting}
        sizing={sizing}
        selectedCount={selected.length}
        missingBytes={missingBytes}
        selectionBytes={selectionBytes}
        blocked={Boolean((verdict && !verdict.fits) || (cache?.backend === "browser" && cache.unavailable))}
        onDownload={() => void download()}
      />
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();
const NO_OUTCOMES: ReadonlyMap<string, MapDownloadPlanOutcome> = new Map();

function sumFor(totals: ReadonlyMap<string, number> | undefined, ids: readonly string[]): number | null {
  if (!totals) return null;
  let sum = 0;
  for (const id of ids) {
    const value = totals.get(id);
    if (value === undefined) return null;
    sum += value;
  }
  return sum;
}

function Notice({ tone, testId, children }: { tone: "warning" | "critical" | "info"; testId?: string; children: ReactNode }) {
  const Icon = tone === "critical" ? CircleAlert : tone === "warning" ? AlertTriangle : Info;
  return (
    <p
      role={tone === "info" ? "status" : "alert"}
      data-testid={testId}
      {...stylex.props(typography.bodySm, styles.notice, tone === "critical" ? styles.noticeCritical : tone === "warning" ? styles.noticeWarning : styles.noticeInfo)}
    >
      <Icon {...stylex.props(styles.noticeIcon)} aria-hidden="true" />
      <span {...stylex.props(styles.noticeText)}>{children}</span>
    </p>
  );
}

function Stage({ job, stage, label, roadFraction, complete, selectedCount, selectionBytes, missingBytes, sizing, preference }: {
  job: MapDownloadSnapshot | null;
  stage: { id: string; plan: MapDownloadPlan | null; lit: ReadonlySet<string>; active: string | null; progress: MapDownloadMapProgress | null } | null;
  label: string | null;
  roadFraction: number;
  complete: boolean;
  selectedCount: number;
  selectionBytes: number;
  missingBytes: number;
  sizing: boolean;
  preference: RenderingPreference;
}) {
  const running = job?.status === "downloading" || job?.status === "planning";
  const inJob = job && job.status !== "idle";
  const doneMaps = job?.maps.filter((map) => map.state === "done").length ?? 0;
  const elapsed = job?.startedAt && job.finishedAt ? (job.finishedAt - job.startedAt) / 1000 : null;
  const headline = !inJob
    ? label ?? "Choose maps below"
    : complete
      ? `All set · ${doneMaps} ${doneMaps === 1 ? "map is" : "maps are"} ready${elapsed !== null ? ` in ${formatDuration(elapsed)}` : ""}`
      : job.status === "paused"
        ? "Paused"
        : job.status === "planning"
          ? "Preparing the download…"
          : job.status === "cancelled"
            ? "Download cancelled · finished files stay cached"
            : job.status === "failed"
              ? "Download stopped"
              : `Building ${label ?? "maps"}`;
  const progress = stage?.progress;
  const cityLabel = stage?.plan
    ? `${label}: ${stage.lit.size} of ${stage.plan.cells.length + (stage.plan.assets.some((asset) => asset.kind === "roads") ? 1 : 0)} parts downloaded`
    : "No map selected";
  return (
    <section {...stylex.props(hairline.all, styles.stage)} aria-label="Download progress" data-testid="map-downloads-stage" data-stage-map={stage?.id ?? ""}>
      <div {...stylex.props(styles.stageHead)}>
        <p {...stylex.props(typography.title, styles.stageName, styles.title)} data-testid="map-downloads-stage-headline">
          {complete ? <Check {...stylex.props(styles.icon, styles.headlineIcon)} aria-hidden="true" /> : null}
          <span {...stylex.props(textLayout.truncate)}>{headline}</span>
        </p>
        {progress ? (
          <MetaLabel data-testid="map-downloads-stage-map-bytes">
            {formatDownloadBytes(progress.doneBytes)} / {formatDownloadBytes(progress.totalBytes)}
          </MetaLabel>
        ) : stage?.plan ? <MetaLabel>{formatDownloadBytes(stage.plan.totalBytes)}</MetaLabel> : null}
      </div>
      <div {...stylex.props(styles.stageCity)}>
        {stage?.plan ? (
          <MapDownloadCity
            columns={stage.plan.columns}
            rows={stage.plan.rows}
            cells={stage.plan.cells}
            lit={stage.lit}
            activeCell={stage.active}
            label={cityLabel}
            testId="map-downloads-city"
          />
        ) : (
          <div {...stylex.props(styles.stageEmpty)}>
            <p {...stylex.props(typography.bodySm)}>{sizing ? "Measuring the maps at this setting…" : "Select a map to see it here."}</p>
          </div>
        )}
      </div>
      <div
        {...mergeStyleProps(stylex.props(styles.road), undefined, { "--road-progress": Math.min(1, Math.max(0, roadFraction)) } as CSSProperties)}
        role="progressbar"
        aria-label="Overall download"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(roadFraction * 100)}
        data-testid="map-downloads-road"
      >
        <span {...stylex.props(styles.roadBed)} />
        <span {...stylex.props(styles.roadPaved)} />
        <Flag {...stylex.props(styles.flag, complete && styles.flagDone)} aria-hidden="true" />
        <CarFront {...stylex.props(styles.car, !running && !complete && styles.carIdle)} aria-hidden="true" />
      </div>
      <dl {...stylex.props(styles.stats)}>
        {inJob ? (
          <>
            <Stat label="Progress" value={`${Math.floor(roadFraction * 100)}%`} testId="map-downloads-percent" />
            <Stat label="Speed" value={running ? `${formatDownloadBytes(job.bytesPerSecond)}/s` : "—"} testId="map-downloads-speed">
              <Sparkline samples={job.samples} />
            </Stat>
            <Stat label="Time left" value={running ? formatDuration(job.etaSeconds) : complete ? "Done" : "—"} testId="map-downloads-eta" />
            <Stat label="Downloaded" value={`${formatDownloadBytes(job.doneBytes)} of ${formatDownloadBytes(job.totalBytes)}`} testId="map-downloads-done-bytes" />
          </>
        ) : (
          <>
            <Stat label="Selected" value={`${selectedCount} ${selectedCount === 1 ? "map" : "maps"}`} />
            <Stat label="Size" value={sizing ? "Sizing…" : formatDownloadBytes(selectionBytes)} testId="map-downloads-selection-bytes" />
            <Stat label="To download" value={sizing ? "Sizing…" : formatDownloadBytes(missingBytes)} testId="map-downloads-missing-bytes" />
            <Stat label="Setting" value={RENDERING_PREFERENCE_CHOICES.find((choice) => choice.id === preference)!.label} />
          </>
        )}
      </dl>
    </section>
  );
}

function Stat({ label, value, testId, children }: { label: string; value: string; testId?: string; children?: ReactNode }) {
  return (
    <div {...stylex.props(styles.stat)}>
      <dt {...stylex.props(typography.eyebrow)}>{label}</dt>
      <dd {...stylex.props(typography.numeric, textLayout.truncate, styles.statValue)} data-testid={testId}>{value}</dd>
      {children}
    </div>
  );
}

function Sparkline({ samples }: { samples: readonly number[] }) {
  if (samples.length < 2) return <svg {...stylex.props(styles.sparkline)} aria-hidden="true" />;
  const max = Math.max(1, ...samples);
  const step = SPARK_WIDTH / (samples.length - 1);
  const line = samples.map((value, index) => `${(index * step).toFixed(1)},${(SPARK_HEIGHT - (value / max) * SPARK_HEIGHT).toFixed(1)}`).join(" ");
  return (
    <svg {...stylex.props(styles.sparkline)} viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,${SPARK_HEIGHT} ${line} ${SPARK_WIDTH},${SPARK_HEIGHT}`} {...stylex.props(styles.sparkArea)} />
      <polyline points={line} {...stylex.props(styles.sparkPath)} />
    </svg>
  );
}

function CacheSection({ cache, missingBytes, verdict, locked, onChanged }: {
  cache: Extract<MapAssetCacheStatus, { backend: "browser" }> | null;
  missingBytes: number;
  verdict: ReturnType<typeof assessMapDownloadCapacity> | null;
  locked: boolean;
  onChanged: () => void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const ceiling = cache?.budgetBytes ?? 0;
  const cachedShare = ceiling > 0 ? (cache?.mapBytes ?? 0) / ceiling : 0;
  const incomingShare = ceiling > 0 ? missingBytes / ceiling : 0;
  const over = verdict !== null && !verdict.fits;
  const chosen = cache?.budgetSetting;
  const choose = (setting: MapAssetCacheBudgetSetting) => {
    setMapAssetCacheBudget(setting);
    onChanged();
  };
  const clear = async () => {
    setClearing(true);
    try {
      await clearMapAssetCache();
    } finally {
      setClearing(false);
      setConfirmClear(false);
      onChanged();
    }
  };
  return (
    <section {...stylex.props(hairline.all, styles.section)} aria-labelledby="map-downloads-storage" data-testid="map-downloads-storage">
      <div {...stylex.props(styles.sectionHead)}>
        <h3 id="map-downloads-storage" {...stylex.props(typography.eyebrow, styles.title)}>Storage in this browser</h3>
        <MetaLabel data-testid="map-downloads-persistence">{cache ? (cache.persistent ? "Kept by the browser" : "Best effort") : "Reading…"}</MetaLabel>
      </div>
      <div
        {...mergeStyleProps(stylex.props(styles.meter), undefined, { "--meter-cached": cachedShare, "--meter-incoming": incomingShare } as CSSProperties)}
        role="img"
        aria-label={`${formatDownloadBytes(cache?.mapBytes ?? 0)} cached and ${formatDownloadBytes(missingBytes)} to download, of a ${formatDownloadBytes(ceiling)} cache`}
        data-testid="map-downloads-meter"
      >
        <span {...stylex.props(styles.meterCached)} />
        <span {...stylex.props(styles.meterIncoming, over && styles.meterOver)} />
      </div>
      <dl {...stylex.props(styles.legend)}>
        <div {...stylex.props(styles.legendItem)}>
          <dt {...stylex.props(typography.eyebrow)}><span {...stylex.props(styles.swatch, styles.swatchCached)} />Cached maps</dt>
          <dd {...stylex.props(typography.bodySm, typography.numeric, styles.legendValue)} data-testid="map-downloads-cached-bytes">{formatDownloadBytes(cache?.mapBytes ?? 0)}</dd>
        </div>
        <div {...stylex.props(styles.legendItem)}>
          <dt {...stylex.props(typography.eyebrow)}><span {...stylex.props(styles.swatch, styles.swatchIncoming)} />To download</dt>
          <dd {...stylex.props(typography.bodySm, typography.numeric, styles.legendValue)}>{formatDownloadBytes(missingBytes)}</dd>
        </div>
        <div {...stylex.props(styles.legendItem)}>
          <dt {...stylex.props(typography.eyebrow)}>Cache ceiling</dt>
          <dd {...stylex.props(typography.bodySm, typography.numeric, styles.legendValue)} data-testid="map-downloads-ceiling">
            {cache ? formatDownloadBytes(ceiling) : "—"}
            {cache && chosen?.kind === "bytes" && ceiling < chosen.bytes ? ` (${formatDownloadBytes(chosen.bytes)} asked; half the browser quota is the limit)` : ""}
          </dd>
        </div>
        <div {...stylex.props(styles.legendItem)}>
          <dt {...stylex.props(typography.eyebrow)}>Browser quota</dt>
          <dd {...stylex.props(typography.bodySm, typography.numeric, styles.legendValue)} data-testid="map-downloads-quota">
            {cache?.quotaBytes != null ? `${formatDownloadBytes(cache.quotaBytes)} · site uses ${formatDownloadBytes(cache.usedBytes ?? 0)}` : "Not reported"}
          </dd>
        </div>
      </dl>
      <div {...stylex.props(styles.presets)} role="group" aria-label="Cache size">
        {PRESETS.map((preset) => {
          const tooBig = cache?.maxBudgetBytes != null && preset.setting.kind === "bytes" && preset.setting.bytes > cache.maxBudgetBytes;
          const current = chosen?.kind === "bytes" && preset.setting.kind === "bytes" && chosen.bytes === preset.setting.bytes;
          return (
            <Button
              key={preset.label}
              size="xs"
              variant={current ? "accentOutline" : "outline"}
              aria-pressed={current}
              disabled={locked || tooBig || !cache}
              title={tooBig ? "More than half of what this browser grants the site" : undefined}
              onClick={() => choose(preset.setting)}
              data-testid="map-downloads-size"
              data-size={preset.label}
            >
              {preset.label}
            </Button>
          );
        })}
        <Button
          size="xs"
          variant={chosen?.kind === "max" ? "accentOutline" : "outline"}
          aria-pressed={chosen?.kind === "max"}
          disabled={locked || !cache || cache.maxBudgetBytes === null}
          title="Half of the storage this browser grants the site"
          onClick={() => choose({ kind: "max" })}
          data-testid="map-downloads-size"
          data-size="max"
        >
          Max{cache?.maxBudgetBytes != null ? ` · ${formatDownloadBytes(cache.maxBudgetBytes)}` : ""}
        </Button>
        <Button
          size="xs"
          variant="quiet"
          disabled={locked || !cache || cache.mapBytes === 0 || clearing}
          onClick={() => setConfirmClear(true)}
          data-testid="map-downloads-clear"
        >
          <Trash2 aria-hidden="true" />
          {clearing ? "Clearing…" : "Clear cache"}
        </Button>
      </div>
      {confirmClear ? (
        <div {...stylex.props(styles.confirm)} role="alertdialog" aria-label="Confirm clearing the map cache">
          <p {...stylex.props(typography.bodySm, styles.title)}>
            Delete all {formatDownloadBytes(cache?.mapBytes ?? 0)} of cached maps from this browser? They download again when needed.
          </p>
          <div {...stylex.props(styles.confirmActions)}>
            <Button size="sm" variant="destructive" onClick={() => void clear()} data-testid="map-downloads-clear-confirm">Delete cached maps</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>Keep</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MapTile({
  map, plan, reason, selected, locked, live, residentBytes, lit, activeCell, confirmingDelete,
  onToggle, onFocus, onDelete, onConfirmDelete, onCancelDelete,
}: {
  map: MapDownloadsCatalogMap;
  plan: MapDownloadPlan | null;
  reason: string | null;
  selected: boolean;
  locked: boolean;
  live: MapDownloadMapProgress | null;
  residentBytes: number;
  lit: ReadonlySet<string>;
  activeCell: string | null;
  confirmingDelete: boolean;
  onToggle: () => void;
  onFocus: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const unavailable = map.locked || reason !== null;
  const total = plan?.totalBytes ?? live?.totalBytes ?? 0;
  const done = total > 0 && residentBytes >= total;
  const share = total > 0 ? residentBytes / total : 0;
  const state = map.locked ? "locked"
    : reason ? "unavailable"
      : live?.state === "failed" ? "failed"
        : live?.state === "downloading" ? "downloading"
          : live?.state === "queued" && locked ? "queued"
            : done ? "done"
              : share >= PARTIAL_SHARE ? "partial" : "absent";
  const chip = {
    locked: { tone: "muted" as const, text: "Not in your plan" },
    unavailable: { tone: "critical" as const, text: "Unavailable" },
    failed: { tone: "critical" as const, text: "Failed" },
    downloading: { tone: "accent" as const, text: `${Math.floor(share * 100)}%` },
    queued: { tone: "neutral" as const, text: "Queued" },
    done: { tone: "positive" as const, text: "On this device" },
    partial: { tone: "warning" as const, text: `${Math.floor(share * 100)}% here` },
    absent: { tone: "neutral" as const, text: "Not downloaded" },
  }[state];
  const inputId = `map-download-${map.mapVersionId}`;
  return (
    <article
      {...stylex.props(hairline.all, styles.tile, selected && styles.tileSelected, unavailable && styles.tileUnavailable, tileMarker)}
      data-testid="map-downloads-tile"
      data-map={map.mapVersionId}
      data-state={state}
      data-selected={selected ? "true" : "false"}
      onMouseEnter={onFocus}
      onFocus={onFocus}
    >
      <div {...stylex.props(styles.tileArt)}>
        {map.thumbnailUrl ? <img src={map.thumbnailUrl} alt="" loading="lazy" {...stylex.props(styles.tileThumb)} /> : null}
        <div {...stylex.props(styles.tileCity)}>
          {plan ? (
            <MapDownloadCity columns={plan.columns} rows={plan.rows} cells={plan.cells} lit={lit} activeCell={activeCell} label={`${map.label}: ${chip.text}`} />
          ) : null}
        </div>
        <label htmlFor={inputId} {...stylex.props(styles.tileHit)} aria-hidden="true" />
        <span {...stylex.props(styles.tileCheck)}>
          {map.locked ? (
            <Lock {...stylex.props(styles.icon)} aria-label="Locked" />
          ) : (
            <input
              id={inputId}
              type="checkbox"
              checked={selected}
              disabled={unavailable || locked}
              onChange={onToggle}
              aria-label={`Download ${map.label}`}
              data-testid="map-downloads-select"
              {...stylex.props(focus.ring, styles.checkbox)}
            />
          )}
        </span>
        <span {...stylex.props(styles.tileBadge)}>
          <Chip tone={chip.tone} data-testid="map-downloads-tile-state">{chip.text}</Chip>
        </span>
      </div>
      <div {...stylex.props(styles.tileBody)}>
        <div {...stylex.props(styles.tileRow)}>
          <span {...stylex.props(textLayout.truncate, styles.tileName)} title={map.label}>{map.label}</span>
          <span {...stylex.props(styles.tileControls)}>
            <MetaLabel data-testid="map-downloads-tile-size">
              {reason ? "—" : plan ? (live && live.state === "downloading" ? `${formatDownloadBytes(residentBytes)} / ${formatDownloadBytes(total)}` : formatDownloadBytes(total)) : map.locked ? "—" : "Sizing…"}
            </MetaLabel>
            {(state === "done" || state === "partial") && plan && !locked && !confirmingDelete ? (
              <IconButton label={`Delete ${map.label} from this browser`} size="xs" onClick={onDelete} data-testid="map-downloads-delete">
                <Trash2 />
              </IconButton>
            ) : null}
          </span>
        </div>
        {map.locality ? <span {...stylex.props(typography.meta, textLayout.truncate)}>{map.locality}</span> : null}
        {reason ? <p {...stylex.props(typography.meta, styles.tileReason)} data-testid="map-downloads-tile-reason">{reason}</p> : null}
        {live?.state === "failed" && live.failure ? <p {...stylex.props(typography.meta, styles.tileReason)}>{live.failure}</p> : null}
        {confirmingDelete ? (
          <div {...stylex.props(styles.confirmActions)}>
            <Button size="xs" variant="destructive" onClick={onConfirmDelete} data-testid="map-downloads-delete-confirm">
              Delete {formatDownloadBytes(residentBytes)}
            </Button>
            <Button size="xs" variant="ghost" onClick={onCancelDelete}>Keep</Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ActionBar({ job, starting, sizing, selectedCount, missingBytes, selectionBytes, blocked, onDownload }: {
  job: MapDownloadSnapshot | null;
  starting: boolean;
  sizing: boolean;
  selectedCount: number;
  missingBytes: number;
  selectionBytes: number;
  blocked: boolean;
  onDownload: () => void;
}) {
  const manager = typeof window === "undefined" ? null : getMapDownloadManager();
  const status = job?.status ?? "idle";
  const running = status === "planning" || status === "downloading";
  const inJob = status !== "idle";
  const doneMaps = job?.maps.filter((map) => map.state === "done").length ?? 0;
  const summary = running
    ? `Downloading ${job!.maps.length} ${job!.maps.length === 1 ? "map" : "maps"} · ${doneMaps} done · ${job!.totalBytes > 0 ? Math.floor((job!.doneBytes / job!.totalBytes) * 100) : 0}%`
    : status === "paused"
      ? `Paused at ${formatDownloadBytes(job!.doneBytes)} of ${formatDownloadBytes(job!.totalBytes)} · finished files stay cached`
      : sizing
        ? "Measuring the selected maps…"
        : selectedCount === 0
          ? "Select at least one map"
          : missingBytes === 0 && selectionBytes > 0
            ? "Everything selected is already on this device"
            : `${selectedCount} ${selectedCount === 1 ? "map" : "maps"} · ${formatDownloadBytes(missingBytes)} to download`;
  return (
    <div {...stylex.props(styles.bar)} data-testid="map-downloads-bar">
      <div {...stylex.props(styles.barSummary)}>
        <span {...stylex.props(typography.label, textLayout.truncate)} data-testid="map-downloads-summary">{summary}</span>
        {!inJob ? <span {...stylex.props(typography.meta, styles.barHint)}>Downloading keeps going when you close this panel.</span> : null}
      </div>
      <div {...stylex.props(styles.barActions)}>
        {running ? (
          <>
            <Button variant="outline" onClick={() => manager?.pause()} data-testid="map-downloads-pause"><Pause aria-hidden="true" />Pause</Button>
            <Button variant="ghost" onClick={() => manager?.cancel()} data-testid="map-downloads-cancel"><X aria-hidden="true" />Cancel</Button>
          </>
        ) : status === "paused" ? (
          <>
            <Button variant="accent" onClick={() => void manager?.resume()} data-testid="map-downloads-resume"><Play aria-hidden="true" />Resume</Button>
            <Button variant="ghost" onClick={() => manager?.cancel()} data-testid="map-downloads-cancel"><X aria-hidden="true" />Cancel</Button>
          </>
        ) : (
          <>
            {inJob ? <Button variant="ghost" onClick={() => manager?.dismiss()} data-testid="map-downloads-dismiss">Clear status</Button> : null}
            <Button
              variant="accent"
              size="lg"
              disabled={starting || sizing || blocked || selectedCount === 0 || missingBytes === 0}
              onClick={onDownload}
              data-testid="map-downloads-start"
            >
              <Download aria-hidden="true" />
              {starting ? "Starting…" : missingBytes === 0 && selectionBytes > 0 ? "Downloaded" : `Download${missingBytes > 0 ? ` ${formatDownloadBytes(missingBytes)}` : ""}`}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
