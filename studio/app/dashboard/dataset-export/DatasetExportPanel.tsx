"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./dataset-export.stylex";
import {
  Download,
  LoaderCircle,
  PackageCheck,
  PackagePlus,
  RefreshCw,
} from "lucide-react";
import { useVisiblePolling } from "@simforge-oss/studio-ui/lib/use-visible-polling";
import {
  DATASET_EXPORT_RECIPES,
  isDatasetExportRecipeQueueable,
  type DatasetExportRecipeId,
} from "@/app/lib/studio-shared/dataset-export-recipes";
import type { ExportFormat } from "@/app/lib/studio-shared/dataset";

type ExportJob = {
  id: string;
  status: string;
  phase?: string | null;
  datasetSnapshotId?: string | null;
  format: ExportFormat;
  recipe?: string | null;
  defaultPublicationId?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type ExportDownloadResponse = {
  kind?: string;
  url?: string | null;
  manifestUrl?: string | null;
  s3Bucket?: string | null;
  s3Prefix?: string | null;
  expiresIn?: number;
};

type LoadState = "idle" | "loading" | "ready" | "error";

type ToastState = {
  kind: "success" | "error";
  message: string;
};

const EXPORT_POLL_INTERVAL_MS = 7000;
const EXPORT_RECIPE_LABELS = DATASET_EXPORT_RECIPES.map((recipe) => ({
  id: recipe.id,
  label: recipe.name,
  description: recipe.description,
  format: recipe.format,
  queueable: isDatasetExportRecipeQueueable(recipe),
}));
const EXPORT_RECIPE_OPTIONS = EXPORT_RECIPE_LABELS.filter(
  (recipe) => recipe.queueable,
);
const DEFAULT_EXPORT_RECIPE_OPTION = EXPORT_RECIPE_OPTIONS[0]!;

function shortId(id: string | null | undefined, chars = 8): string {
  if (!id) return "-";
  return id.length > chars ? id.slice(0, chars) : id;
}

function recipeLabel(recipeId: string | null | undefined, format: ExportFormat) {
  const recipe = EXPORT_RECIPE_LABELS.find((option) => option.id === recipeId);
  return recipe?.label ?? format.replaceAll("_", " ");
}

function formatJobTime(value: string | null | undefined) {
  if (!value) return "Not started";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function exportStatusLabel(status: string, phase: string | null | undefined) {
  if (status === "queued") return "Queued";
  if (status === "running") return phase ? `Running: ${phase.replaceAll("_", " ")}` : "Running";
  if (status === "succeeded") return "Ready";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return status.replaceAll("_", " ");
}

function exportStatusStyle(status: string) {
  if (status === "succeeded") return styles.statusSuccess;
  if (status === "failed" || status === "cancelled") return styles.statusError;
  if (status === "running") return styles.statusRunning;
  return styles.statusDefault;
}

function canDownloadExport(job: ExportJob) {
  return job.status === "succeeded" || Boolean(job.defaultPublicationId);
}

function hasLiveExportJobs(jobs: ExportJob[]) {
  return jobs.some((job) => job.status === "queued" || job.status === "running");
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) {
        throw new Error(text.length > 180 ? `${text.slice(0, 177)}...` : text);
      }
      throw new Error("Response was not valid JSON.");
    }
  }
  if (typeof response.json === "function") return response.json() as Promise<unknown>;
  return null;
}

function responseError(value: unknown, fallback: string) {
  const record = asRecord(value);
  return typeof record?.error === "string" ? record.error : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isExportFormat(value: unknown): value is ExportFormat {
  return (
    value === "REVIEW_BUNDLE" ||
    value === "NATIVE_FULL" ||
    value === "ODVG" ||
    value === "ALPAMAYO_SFT"
  );
}

function parseExportJob(value: unknown): ExportJob | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    typeof record.id !== "string" ||
    typeof record.status !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !isExportFormat(record.format)
  ) {
    return null;
  }
  return {
    id: record.id,
    status: record.status,
    format: record.format,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    phase: typeof record.phase === "string" ? record.phase : null,
    datasetSnapshotId:
      typeof record.datasetSnapshotId === "string" ? record.datasetSnapshotId : null,
    recipe: typeof record.recipe === "string" ? record.recipe : null,
    defaultPublicationId:
      typeof record.defaultPublicationId === "string" ? record.defaultPublicationId : null,
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : null,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
    finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null,
  };
}

function parseExportJobsResponse(value: unknown): {
  jobs: ExportJob[];
  recipes: DatasetExportRecipeId[] | null;
} {
  const record = asRecord(value);
  if (!record) return { jobs: [], recipes: null };
  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  const recipes = Array.isArray(record.recipes)
    ? record.recipes.filter((recipe): recipe is DatasetExportRecipeId =>
        EXPORT_RECIPE_OPTIONS.some((option) => option.id === recipe),
      )
    : null;
  return {
    jobs: jobs.map(parseExportJob).filter((job): job is ExportJob => Boolean(job)),
    recipes,
  };
}

function parseExportDownloadResponse(value: unknown): ExportDownloadResponse {
  const record = asRecord(value);
  if (!record) return {};
  return {
    kind: typeof record.kind === "string" ? record.kind : undefined,
    url: typeof record.url === "string" ? record.url : null,
    manifestUrl: typeof record.manifestUrl === "string" ? record.manifestUrl : null,
    s3Bucket: typeof record.s3Bucket === "string" ? record.s3Bucket : null,
    s3Prefix: typeof record.s3Prefix === "string" ? record.s3Prefix : null,
    expiresIn: typeof record.expiresIn === "number" ? record.expiresIn : undefined,
  };
}

export function DatasetExportPanel({ datasetId }: { datasetId: string }) {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedRecipe, setSelectedRecipe] =
    useState<DatasetExportRecipeId>("review_bundle");
  // Recipes this installation can actually run; null until the first list
  // response arrives. The shared recipe table is the superset every SimForge
  // deployment understands, the server says which ones it materializes here.
  const [availableRecipes, setAvailableRecipes] = useState<DatasetExportRecipeId[] | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [polling, setPolling] = useState(true);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const recipeOptions = useMemo(
    () =>
      availableRecipes
        ? EXPORT_RECIPE_OPTIONS.filter((recipe) => availableRecipes.includes(recipe.id))
        : EXPORT_RECIPE_OPTIONS,
    [availableRecipes],
  );
  const selected = useMemo(
    () =>
      recipeOptions.find((recipe) => recipe.id === selectedRecipe) ??
      recipeOptions[0] ??
      DEFAULT_EXPORT_RECIPE_OPTION,
    [recipeOptions, selectedRecipe],
  );
  const latestJob = jobs[0] ?? null;
  const latestReady = latestJob ? canDownloadExport(latestJob) : false;

  const showToast = useCallback((next: ToastState) => {
    setToast(next);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), 7000);
  }, []);

  const loadExports = useCallback(async (signal: AbortSignal) => {
    if (!datasetId) return;
    setState((prev) => (prev === "ready" ? prev : "loading"));
    try {
      const res = await fetch(
        `/api/datasets/${encodeURIComponent(datasetId)}/export-jobs`,
        { cache: "no-store", signal },
      );
      const json = await readResponseBody(res);
      if (!res.ok) throw new Error(responseError(json, `status ${res.status}`));
      if (signal.aborted) return;
      const parsed = parseExportJobsResponse(json);
      setJobs(parsed.jobs);
      if (parsed.recipes) setAvailableRecipes(parsed.recipes);
      setPolling(hasLiveExportJobs(parsed.jobs));
      setState("ready");
      setError(null);
    } catch (loadError) {
      if (
        signal.aborted ||
        (loadError as { name?: string } | null)?.name === "AbortError"
      ) {
        return;
      }
      setPolling(hasLiveExportJobs(jobs));
      setState("error");
      setError(loadError instanceof Error ? loadError.message : "fetch failed");
    }
  }, [datasetId, jobs]);

  useEffect(() => {
    setJobs([]);
    setState("idle");
    setError(null);
    setPolling(true);
  }, [datasetId]);

  useVisiblePolling(
    loadExports,
    EXPORT_POLL_INTERVAL_MS,
    polling,
    `${datasetId}:${refreshGeneration}`,
  );

  const refreshExports = useCallback(() => {
    setPolling(true);
    setRefreshGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const handleQueue = useCallback(async () => {
    setQueueing(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/datasets/${encodeURIComponent(datasetId)}/export-jobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            format: selected.format,
            recipe: selected.id,
          }),
        },
      );
      const json = await readResponseBody(res);
      if (!res.ok) throw new Error(responseError(json, "export failed"));
      const exportId =
        typeof (json as { exportId?: unknown })?.exportId === "string"
          ? (json as { exportId: string }).exportId
          : null;
      showToast({
        kind: "success",
        message: `Queued ${selected.label}${exportId ? `, ${shortId(exportId, 12)}` : ""}`,
      });
      refreshExports();
    } catch (queueError) {
      showToast({
        kind: "error",
        message: queueError instanceof Error ? queueError.message : "Failed to queue export",
      });
    } finally {
      setQueueing(false);
    }
  }, [datasetId, refreshExports, selected, showToast]);

  const handleDownload = useCallback(
    async (job: ExportJob) => {
      setDownloadingId(job.id);
      try {
        const res = await fetch(
          `/api/datasets/${encodeURIComponent(datasetId)}/export-jobs/${encodeURIComponent(job.id)}/download`,
          { cache: "no-store" },
        );
        const json = await readResponseBody(res);
        if (!res.ok) throw new Error(responseError(json, "download failed"));
        const parsed = parseExportDownloadResponse(json);
        const url = parsed.url ?? parsed.manifestUrl ?? null;
        if (!url) {
          throw new Error(
            parsed.s3Bucket && parsed.s3Prefix
              ? `Export is ready at s3://${parsed.s3Bucket}/${parsed.s3Prefix}`
              : "Export is ready, but no browser download URL was returned.",
          );
        }
        window.open(url, "_blank", "noopener,noreferrer");
        showToast({
          kind: "success",
          message: `Opened ${recipeLabel(job.recipe, job.format)} download`,
        });
      } catch (downloadError) {
        showToast({
          kind: "error",
          message: downloadError instanceof Error ? downloadError.message : "Download failed",
        });
      } finally {
        setDownloadingId(null);
      }
    },
    [datasetId, showToast],
  );

  return (
    <section {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.minWidth)}>
          <div {...stylex.props(styles.flexWrapGap)}>
            <PackageCheck {...stylex.props(styles.iconYellow)} />
            <h3 {...stylex.props(styles.eyebrow)}>Export bundle</h3>
            {latestJob ? <span {...stylex.props(styles.status, exportStatusStyle(latestJob.status))}>{exportStatusLabel(latestJob.status, latestJob.phase)}</span> : null}
          </div>
          <p {...stylex.props(styles.description)}>
            Create a downloadable package from the current dataset artifacts.
            Exports run as background jobs and become downloadable when publication
            finishes.
          </p>
        </div>
        <div {...stylex.props(styles.actions)}>
          <button type="button" onClick={refreshExports} disabled={state === "loading"} {...stylex.props(styles.button)}>
            <RefreshCw {...stylex.props(styles.iconSmall, state === "loading" && styles.iconSpin)} /> Refresh
          </button>
          {latestJob ? (
            <button type="button" onClick={() => void handleDownload(latestJob)} disabled={!latestReady || downloadingId === latestJob.id} {...stylex.props(styles.button, styles.primaryButton)}>
              {downloadingId === latestJob.id ? <LoaderCircle {...stylex.props(styles.iconSmall, styles.iconSpin)} /> : <Download {...stylex.props(styles.iconSmall)} />}
              Download latest
            </button>
          ) : null}
        </div>
      </header>
      <div {...stylex.props(styles.exportGrid)}>
        <div {...stylex.props(styles.borderSection)}>
          <div {...stylex.props(styles.recipeGrid)}>
            {recipeOptions.map((recipe) => {
              const active = recipe.id === selected.id;
              return (
                <button key={recipe.id} type="button" onClick={() => setSelectedRecipe(recipe.id)} {...stylex.props(styles.recipeCard, active && styles.recipeActive)}>
                  <div {...stylex.props(styles.recipeTop)}>
                    <span {...stylex.props(styles.monoLabel)}>{recipe.format.replaceAll("_", " ")}</span>
                    <span aria-hidden="true" {...stylex.props(styles.marker, active && styles.markerActive)} />
                  </div>
                  <div {...stylex.props(styles.recipeTitle)}>{recipe.label}</div>
                  <p {...stylex.props(styles.recipeDescription)}>{recipe.description}</p>
                </button>
              );
            })}
          </div>
          <div {...stylex.props(styles.queueRow)}>
            <button type="button" onClick={() => void handleQueue()} disabled={queueing} {...stylex.props(styles.button, styles.queueButton)}>
              {queueing ? <LoaderCircle {...stylex.props(styles.iconMedium, styles.iconSpin)} /> : <PackagePlus {...stylex.props(styles.iconMedium)} />}
              Queue export
            </button>
            <div {...stylex.props(styles.subtleMono)}>{selected.label} · {selected.format.replaceAll("_", " ")}</div>
          </div>
        </div>
        <aside {...stylex.props(styles.jobs)}>
          <div {...stylex.props(styles.jobsHeader)}>
            <span {...stylex.props(styles.monoLabel, styles.mutedColor)}>Export jobs</span>
            <span {...stylex.props(styles.count)}>{jobs.length}</span>
          </div>
          {error && jobs.length > 0 ? <div {...stylex.props(styles.error)}>{error}</div> : null}
          {state === "loading" && jobs.length === 0 ? (
            <div {...stylex.props(styles.skeletonWrap)}>{[1, 2, 3].map((key) => <div key={key} {...stylex.props(styles.skeleton)} />)}</div>
          ) : error && jobs.length === 0 ? (
            <div {...stylex.props(styles.error)}>{error}</div>
          ) : jobs.length === 0 ? (
            <div {...stylex.props(styles.empty)}>No exports yet. Pick a recipe and queue the first bundle.</div>
          ) : (
            <ol {...stylex.props(styles.jobsList)}>
              {jobs.slice(0, 5).map((job) => {
                const downloadable = canDownloadExport(job);
                return (
                  <li key={job.id} {...stylex.props(styles.job)}>
                    <div {...stylex.props(styles.jobTop)}>
                      <div {...stylex.props(styles.minWidth)}>
                        <div {...stylex.props(styles.truncate)}>{recipeLabel(job.recipe, job.format)}</div>
                        <div {...stylex.props(styles.jobMeta)}>{shortId(job.id, 12)} · {formatJobTime(job.createdAt)}</div>
                      </div>
                      <span {...stylex.props(styles.status, exportStatusStyle(job.status))}>{exportStatusLabel(job.status, job.phase)}</span>
                    </div>
                    {job.errorMessage ? <div {...stylex.props(styles.jobError)}>{job.errorMessage}</div> : null}
                    <div {...stylex.props(styles.jobBottom)}>
                      <span {...stylex.props(styles.snapshotMono)}>Snapshot {shortId(job.datasetSnapshotId, 8)}</span>
                      <button type="button" onClick={() => void handleDownload(job)} disabled={!downloadable || downloadingId === job.id} {...stylex.props(styles.downloadButton)}>
                        {downloadingId === job.id ? <LoaderCircle {...stylex.props(styles.iconSmall, styles.iconSpin)} /> : <Download {...stylex.props(styles.iconSmall)} />} Download
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>
      </div>
      {toast ? <p {...stylex.props(styles.toast, toast.kind === "success" ? styles.toastSuccess : styles.toastError)}>{toast.message}</p> : null}
    </section>
  );
}
