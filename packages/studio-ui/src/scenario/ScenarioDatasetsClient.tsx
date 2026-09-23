"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioDatasetsClient.stylex";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  ScenarioDatasetDto,
  ScenarioDocumentSummaryDto,
} from "../lib/scenario/contracts";
import type { CityViewer } from "@simforge-oss/viewer";
import type { ActorRenderer } from "@simforge-oss/viewer";
import { useRouteHeader } from "../components/TopBarSlot";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { CloudLoadingSurface } from "../components/CloudLoadingSurface";
import { CopyableErrorMessage } from "./list/CopyableErrorMessage";
import { MetadataDetailsDialog } from "./list/MetadataDetailsDialog";
import { NewDatasetDialog } from "./list/NewDatasetDialog";
import { WorkspacePanes, type WorkspacePane } from "../components/WorkspacePanes";
import { ListSkeleton } from "../components/ListSkeleton";
import { RouteErrorState } from "../components/state-frames";
import { ScenarioDatasetDetailClient } from "./dataset/ScenarioDatasetDetailClient";
import { ScenarioEditorClient } from "./editor/ScenarioEditorClient";
import { DatasetRenderPane } from "./render/DatasetRenderPane";
import { DatasetStrip } from "./rail/DatasetStrip";
import type { DatasetCloudHome } from "./rail/dataset-home";

export type { DatasetCloudHome } from "./rail/dataset-home";
import { ScenarioCoverageMap } from "./coverage/ScenarioCoverageMap";
import { useScenarioSession } from "./scene/useScenarioSession";
import { ScenarioSumoTraffic } from "./scene/ScenarioSumoTraffic";
import { ScenarioSessionProvider } from "./scene/ScenarioSessionContext";
import {
  type ScenarioWorldState,
  type ScenarioWorldTarget,
} from "./scene/ScenarioWorldHost";
import { ScenarioWorldSurface } from "./scene/ScenarioWorldProvider";
import type { ScenarioMapGroup } from "./list/document-map-groups";
import { useStudioHost } from "../host";
import { ScenarioNameConflict } from "@simforge-oss/studio-host";
import { scenarioListCache } from "./list/scenarioListCache";
import {
  hydrateScenarioViewStateFromStorage,
  persistScenarioViewState,
} from "./list/scenarioViewState";
import { runDatasetMorph } from "./list/datasetMorph";
import { driveHref } from "./drive-route";
import { hairline } from "../stylex/recipes.stylex";

/** Shared width key for the floating dataset/scenario sidebar. */
const SCENARIO_LIST_WIDTH_KEY = "uniscenario.scenario-list-width.v2";

/** No world mounted: what the workspace publishes while browsing, and again after a release. */
const NO_WORLD_STATE: ScenarioWorldState = {
  target: null,
  loadedMapVersionId: null,
  preparedMapVersionId: null,
  streaming: false,
  error: null,
};

type EditDraft = { id: string; name: string; description: string };
type FailedOperation = "load" | "create" | "save" | "delete";
type DatasetRightPaneMode = "map" | "render";
type RenderTarget = Pick<
  ScenarioDocumentSummaryDto,
  "id" | "title" | "latestRevisionId"
>;

function datasetHref(datasetId: string) {
  return `/dashboard/scenario/${encodeURIComponent(datasetId)}`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The dataset index.
 *
 * Replaces the 45-line grid that fetched in a bare `useEffect` with no `AbortController`, refetched
 * the whole list after every create, and showed `itemCount` — the count of pinned revision×render-job
 * pairs, which reads 0 for every dataset until someone pins one.
 *
 * `initialDatasets` is the house pattern (§5.6): the server component reads and seeds, the client
 * splices its own mutations locally, and nothing refetches after a mutation. The prop is optional
 * only because `dashboard/scenario/page.tsx` does not pass it yet — when it is absent this falls
 * back to an aborted client fetch, which is strictly worse and is meant to go away.
 */
export function ScenarioDatasetsClient({
  initialDatasets,
  cloudHome = { state: "signed-out" },
}: {
  initialDatasets?: ScenarioDatasetDto[];
  /**
   * The cloud half of the strip's home sections. The host supplies it because the SimCloud
   * connection lives in the host, not in this package; with no host answer yet the strip shows the
   * signed-out cloud section, which is a true statement about an unconnected installation and not
   * an empty space.
   */
  cloudHome?: DatasetCloudHome;
}) {
  const studioHost = useStudioHost();
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeQuery = searchParams.toString();
  const internallyWrittenQueryRef = useRef<string | null>(null);
  const [datasets, setDatasets] = useState<ScenarioDatasetDto[] | null>(
    () =>
      initialDatasets ??
      (scenarioListCache.datasetsLoaded
        ? scenarioListCache.datasets
        : null),
  );
  const [activePane, setActivePane] = useState<WorkspacePane>(() => searchParams.get("pane") === "render" ? "detail" : "list");
  const [newDatasetOpen, setNewDatasetOpen] = useState(false);
  const [newDatasetName, setNewDatasetName] = useState("");
  const [newDatasetError, setNewDatasetError] = useState<string | null>(null);
  const [creatingDataset, setCreatingDataset] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [busyDatasetId, setBusyDatasetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedOperation, setFailedOperation] =
    useState<FailedOperation | null>(null);
  const failedDatasetIdRef = useRef<string | null>(null);
  const viewStateHydratedRef = useRef(false);

  // The scenario list reads its highlighted row from this same cache. Hydrate
  // it here as well so the world preview and the row restore one identity.
  if (!viewStateHydratedRef.current) {
    viewStateHydratedRef.current = true;
    hydrateScenarioViewStateFromStorage();
  }

  /**
   * Which dataset the scenario column is showing.
   *
   * Selecting a dataset swaps the column's contents rather than navigating: a route change would
   * re-run the server component and rebuild the whole workspace just to change what the column
   * lists. `null` only while the list is loading or empty; once datasets exist, the effect below
   * always resolves one.
   */
  const [openDatasetId, setOpenDatasetId] = useState<string | null>(() => searchParams.get("dataset"));

  /**
   * The document open in the editor, if any — the v2 equivalent of v1's `?pane=editor`.
   *
   * v1 kept the list and the editor as two modes of one mounted surface. Holding this in state rather
   * than routing to `/scenario/editor` is what keeps the pencil a toggle instead of a one-way trip.
   */
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(() =>
    searchParams.get("dataset") && searchParams.get("pane") !== "render" ? searchParams.get("document") : null,
  );
  /** Whether the open editor has resolved its record and map, which is when its chrome appears. */
  const [editorReady, setEditorReady] = useState(false);
  /** The selected row: what `?preview=` addresses, and what a render pane opens against. */
  const [previewDocumentId, setPreviewDocumentId] = useState<string | null>(null);
  /** The open dataset's scenarios grouped by map, published by the scenario column. */
  const [mapGroups, setMapGroups] = useState<ScenarioMapGroup[]>([]);
  /** The coverage region whose scenarios the column has expanded. */
  const [selectedMapVersionId, setSelectedMapVersionId] = useState<string | null>(null);
  const [creatingScenarioMapVersionId, setCreatingScenarioMapVersionId] = useState<string | null>(null);
  const [datasetRightPaneMode, setDatasetRightPaneMode] =
    useState<DatasetRightPaneMode>("map");
  const [renderTarget, setRenderTarget] = useState<RenderTarget | null>(null);
  const [renderWorkLive, setRenderWorkLive] = useState(false);
  const [renderCompletionGeneration, setRenderCompletionGeneration] = useState(0);
  // The render pane asks for the whole width when it opens one render or the create form. The list
  // slides out rather than unmounting, so returning to the gallery restores it without a refetch.
  const [renderImmersive, setRenderImmersive] = useState(false);
  const renderActivityRef = useRef<{ activityKey: string; live: boolean } | null>(null);
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [actorRenderer, setActorRenderer] = useState<ActorRenderer | null>(
    null,
  );
  const [worldTarget, setWorldTarget] = useState<ScenarioWorldTarget | null>(null);
  const [worldState, setWorldState] = useState<ScenarioWorldState>(NO_WORLD_STATE);
  const scenarioSession = useScenarioSession({
    documentId: openDocumentId,
    viewer,
    actorRenderer,
    loadedMapVersionId: worldState.loadedMapVersionId,
  });
  const setPlaybackInspecting = scenarioSession.playback.setInspecting;
  const openDataset = openDatasetId
    ? (datasets?.find((dataset) => dataset.id === openDatasetId) ?? null)
    : null;
  useRouteHeader({ title: openDocumentId ? "Editor" : openDataset?.name ?? "Datasets" });

  // Return to the edited map's group even on a gallery deep link: the hidden
  // list deliberately defers its fetch, so it cannot be the identity authority.
  const editedMapVersionId = scenarioSession.document?.id === openDocumentId
    ? scenarioSession.map?.mapVersionId ?? null
    : null;
  const editing = openDocumentId !== null;

  // The list does not need a city. Returning to it is a local state change,
  // not a wait for an unrelated coverage-camera callback (null -> null never
  // produces one on a gallery deep link).
  useEffect(() => {
    if (editing) return;
    setWorldTarget(null);
    setWorldState(NO_WORLD_STATE);
    setViewer(null);
    setActorRenderer(null);
  }, [editing]);

  // The editor is the only publisher of a world target, and it republishes whenever its resolved map
  // object changes identity. Holding the existing target for the same immutable map version keeps the
  // world host's own load and camera effects quiet: authoring and preview APIs can expose different
  // URL forms for one version.
  const publishWorldTarget = useCallback((next: ScenarioWorldTarget) => {
    setWorldTarget((current) =>
      current?.mapVersionId === next.mapVersionId
        ? current
        : next,
    );
  }, []);
  const handleRenderActivityChange = useCallback(
    (activityKey: string, live: boolean) => {
      const previous = renderActivityRef.current;
      if (!live && previous?.live && previous.activityKey !== activityKey) {
        // The previous render target is still live but its pane no longer owns
        // progress. Keep readiness polling rather than allowing stale badges.
        return;
      }
      // The pane's loaded gallery is the authority on this scope's render state. Any time it settles
      // on "nothing live" from a state the list has not reconciled against — a live-to-terminal
      // transition, or a scope first seen already finished because the job ran while the pane was
      // closed or was submitted outside it — the readiness counters get one keyed refresh.
      const settled =
        !live && !(previous && !previous.live && previous.activityKey === activityKey);
      if (settled) {
        setRenderCompletionGeneration((generation) => generation + 1);
      }
      renderActivityRef.current = { activityKey, live };
      setRenderWorkLive(live);
    },
    [],
  );

  const replaceWorkspaceUrl = useCallback((url: URL) => {
    internallyWrittenQueryRef.current = url.searchParams.toString();
    window.history.replaceState(null, "", url);
  }, []);

  const openDocument = useCallback(
    (documentId: string | null) => {
      runDatasetMorph(() => {
        setOpenDocumentId(documentId);
        setPlaybackInspecting(false);
        // Each entry earns its own readiness: the cover only lifts once this session's editor has
        // resolved its record and map, never on the last one's leftover flag.
        setEditorReady(false);
        if (documentId) {
          setPreviewDocumentId(documentId);
          setDatasetRightPaneMode("map");
          setRenderTarget(null);
        }
        const url = new URL(window.location.href);
        if (documentId) {
          url.searchParams.set("document", documentId);
          url.searchParams.delete("preview");
          url.searchParams.delete("pane");
        } else url.searchParams.delete("document");
        replaceWorkspaceUrl(url);
      });
    },
    [replaceWorkspaceUrl, setPlaybackInspecting],
  );

  const previewDocument = useCallback((documentId: string | null) => {
    setPreviewDocumentId(documentId);
    setDatasetRightPaneMode("map");
    setRenderTarget(null);
    const url = new URL(window.location.href);
    if (documentId) {
      url.searchParams.set("preview", documentId);
      url.searchParams.delete("document");
    } else url.searchParams.delete("preview");
    url.searchParams.delete("pane");
    replaceWorkspaceUrl(url);
  }, [replaceWorkspaceUrl]);

  const revealEditor = useCallback(() => {
    runDatasetMorph(() => setEditorReady(true));
  }, []);

  /**
   * Opening a coverage region: the column expands that map's group and scrolls it into view.
   *
   * `null` collapses it again, which is also what clicking the open region on the map means. The
   * choice is remembered per dataset, like the dataset and the selected scenario.
   */
  const selectMap = useCallback((mapVersionId: string | null) => {
    setSelectedMapVersionId(mapVersionId);
    if (!openDatasetId) return;
    const next = { ...scenarioListCache.selectedMapVersionIdByDataset };
    if (mapVersionId === null) delete next[openDatasetId];
    else next[openDatasetId] = mapVersionId;
    scenarioListCache.selectedMapVersionIdByDataset = next;
    persistScenarioViewState();
  }, [openDatasetId]);
  const createScenarioHere = useCallback(async (mapVersionId: string) => {
    if (creatingScenarioMapVersionId) return;
    setCreatingScenarioMapVersionId(mapVersionId);
    try {
      const response = await fetch(
        `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/documents/default`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => null)) as
        | { document?: { id: string; datasetId: string }; error?: string }
        | null;
      if (!response.ok || !payload?.document) {
        throw new Error(payload?.error || "The scenario could not be created.");
      }
      router.push(
        `/dashboard/scenario?dataset=${encodeURIComponent(payload.document.datasetId)}&document=${encodeURIComponent(payload.document.id)}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The scenario could not be created.");
    } finally {
      setCreatingScenarioMapVersionId(null);
    }
  }, [creatingScenarioMapVersionId, router]);

  const driveHere = useCallback((mapVersionId: string) => {
    router.push(`/dashboard/map-assets/drive?map=${encodeURIComponent(mapVersionId)}`);
  }, [router]);

  const toggleRenderPane = useCallback(
    (document: RenderTarget) => {
      const closing =
        datasetRightPaneMode === "render" && renderTarget?.id === document.id;
      const nextMode: DatasetRightPaneMode = closing ? "map" : "render";
      setActivePane("detail");
      setDatasetRightPaneMode(nextMode);
      setRenderTarget(closing ? null : document);
      // A different scenario starts at its own gallery, never inside the previous one's theater.
      setRenderImmersive(false);
      setPreviewDocumentId(document.id);
      setOpenDocumentId(null);

      const url = new URL(window.location.href);
      url.searchParams.set("preview", document.id);
      url.searchParams.delete("document");
      if (nextMode === "render") url.searchParams.set("pane", "render");
      else url.searchParams.delete("pane");
      replaceWorkspaceUrl(url);
    },
    [datasetRightPaneMode, renderTarget?.id, replaceWorkspaceUrl],
  );

  const closeRenderPane = useCallback(() => {
    setDatasetRightPaneMode("map");
    setRenderTarget(null);
    setRenderImmersive(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("pane");
    replaceWorkspaceUrl(url);
  }, [replaceWorkspaceUrl]);

  const selectDataset = useCallback((datasetId: string) => {
    const rememberedDocumentId =
      scenarioListCache.selectedDocumentIdByDataset[datasetId] ?? null;
    setOpenDatasetId(datasetId);
    setEditorReady(false);
    setPreviewDocumentId(rememberedDocumentId);
    setMapGroups([]);
    setSelectedMapVersionId(
      scenarioListCache.selectedMapVersionIdByDataset[datasetId] ?? null,
    );
    setDatasetRightPaneMode("map");
    setRenderTarget(null);
    setRenderImmersive(false);
    renderActivityRef.current = null;
    setRenderWorkLive(false);
    // The last dataset opened is the one the next visit lands on.
    scenarioListCache.selectedDatasetId = datasetId;
    persistScenarioViewState();
    // Keep the URL honest without handing the navigation to the router: `router.push` would re-run the
    // server component and remount the scene, which is the thing this whole arrangement avoids. A
    // `replaceState` leaves a reloadable, copyable URL and no history entry per dataset browsed.
    const url = new URL(window.location.href);
    url.searchParams.set("dataset", datasetId);
    if (rememberedDocumentId) url.searchParams.set("preview", rememberedDocumentId);
    else url.searchParams.delete("preview");
    url.searchParams.delete("pane");
    replaceWorkspaceUrl(url);
  }, [replaceWorkspaceUrl]);

  // Keep mounted workspace state aligned with soft navigation. The app switcher
  // links back to the clean datasets URL without remounting this client, so a
  // one-time read leaves a stale editor or map chooser covering the list.
  useEffect(() => {
    if (internallyWrittenQueryRef.current === routeQuery) {
      internallyWrittenQueryRef.current = null;
      return;
    }
    internallyWrittenQueryRef.current = null;
    const params = new URLSearchParams(routeQuery);
    const dataset = params.get("dataset");
    setOpenDatasetId(dataset);
    // Only meaningful with a dataset: the editor needs both to resolve a document.
    const renderPaneRequested = params.get("pane") === "render";
    const requestedDocument = dataset ? params.get("document") : null;
    const document = renderPaneRequested ? null : requestedDocument;
    setOpenDocumentId(document);
    setEditorReady(false);
    const preview = dataset
      ? params.get("preview")
        ?? (renderPaneRequested ? requestedDocument : null)
        ?? scenarioListCache.selectedDocumentIdByDataset[dataset]
        ?? null
      : null;
    setPreviewDocumentId(document ?? preview);
    if (dataset && !document && preview && renderPaneRequested) {
      setDatasetRightPaneMode("render");
      const cachedDocument = scenarioListCache.documentsByDataset[dataset]?.find(
        (candidate) => candidate.id === preview,
      );
      // A warm list cache carries the immutable revision identity, so reopening render history is
      // read-free. A cold reload carries only identity and lets `DatasetRenderPane` resolve it.
      // `?revision=` pins one immutable revision explicitly: the browser-render worker arrives with
      // the queued job's revision and must never record the document's newer head.
      setRenderTarget({
        id: preview,
        title: cachedDocument?.title ?? "",
        latestRevisionId: params.get("revision") ?? cachedDocument?.latestRevisionId ?? null,
      });
    } else {
      setDatasetRightPaneMode("map");
      setRenderTarget(null);
    }
  }, [routeQuery]);

  // The scenario being edited is by definition in that map's region. Keeping the selection on it
  // means exiting the editor lands back on the region the entry zoomed into, with the column's
  // group still open on the scenario that was being authored.
  useEffect(() => {
    if (editedMapVersionId) setSelectedMapVersionId(editedMapVersionId);
  }, [editedMapVersionId]);

  const publish = useCallback((next: ScenarioDatasetDto[]) => {
    scenarioListCache.datasets = next;
    scenarioListCache.datasetsLoaded = true;
    setDatasets(next);
  }, []);

  useEffect(() => {
    if (!initialDatasets) return;
    scenarioListCache.datasets = initialDatasets;
    scenarioListCache.datasetsLoaded = true;
  }, [initialDatasets]);

  const loadDatasets = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const next = await studioHost.projects.listDatasets(signal);
        if (signal?.aborted) return;
        publish(next);
        setError(null);
        setFailedOperation(null);
      } catch (loadError) {
        if (
          signal?.aborted ||
          (loadError as { name?: string } | null)?.name === "AbortError"
        ) {
          return;
        }
        setError(errorMessage(loadError, "Failed to load datasets."));
        setFailedOperation("load");
      }
    },
    [publish, studioHost],
  );

  useEffect(() => {
    if (initialDatasets || scenarioListCache.datasetsLoaded) return;
    const abort = new AbortController();
    void loadDatasets(abort.signal);
    return () => abort.abort();
  }, [initialDatasets, loadDatasets]);

  const orderedDatasets = useMemo(() => {
    // Workspace-owned datasets first, shared and system datasets after — so the default view is the
    // user's own work, not the templates.
    const rank = (dataset: ScenarioDatasetDto) =>
      dataset.visibility === "workspace" && !dataset.isSystemManaged ? 0 : 1;
    return [...(datasets ?? [])].sort((a, b) => rank(a) - rank(b));
  }, [datasets]);

  // The column always shows a dataset. With nothing selected — first visit, the app switcher's clean
  // URL, a deleted or stale `?dataset=` — land on the one the user last opened, else the first of
  // their own. Writing it back through `selectDataset` keeps the URL reloadable.
  useEffect(() => {
    if (orderedDatasets.length === 0) return;
    if (openDatasetId && orderedDatasets.some((dataset) => dataset.id === openDatasetId)) return;
    const remembered = scenarioListCache.selectedDatasetId;
    const fallback = orderedDatasets.find((dataset) => dataset.id === remembered) ?? orderedDatasets[0]!;
    selectDataset(fallback.id);
  }, [openDatasetId, orderedDatasets, selectDataset]);

  const createDataset = useCallback(async () => {
    const name = newDatasetName.trim();
    if (!name) return;
    setCreatingDataset(true);
    setNewDatasetError(null);
    setError(null);
    setFailedOperation(null);
    try {
      const created = await studioHost.projects.createDataset({ name });
      publish([created, ...(datasets ?? [])]);
      setNewDatasetName("");
      setNewDatasetOpen(false);
      // Like a new Slack channel: you land in it.
      selectDataset(created.id);
    } catch (createError) {
      // A name collision belongs in the dialog, beside the field the user has to change; the
      // constraint is not partial, so a soft-deleted dataset still holds its name. Anything else is a
      // page-level failure with a retry.
      if (createError instanceof ScenarioNameConflict) {
        setNewDatasetError(createError.message);
      } else {
        setError(errorMessage(createError, "Failed to create dataset."));
        setFailedOperation("create");
      }
    } finally {
      setCreatingDataset(false);
    }
  }, [datasets, newDatasetName, publish, selectDataset, studioHost]);

  const saveDatasetDetails = useCallback(async () => {
    if (!editDraft) return;
    const name = editDraft.name.trim();
    if (!name) return;
    const description = editDraft.description.trim();
    setBusyDatasetId(editDraft.id);
    setEditError(null);
    setError(null);
    setFailedOperation(null);
    try {
      const updated = await studioHost.projects.updateDataset(editDraft.id, {
        name,
        description: description || null,
      });
      publish(
        (datasets ?? []).map((dataset) =>
          dataset.id === updated.id ? updated : dataset,
        ),
      );
      setEditDraft(null);
    } catch (updateError) {
      if (updateError instanceof ScenarioNameConflict) {
        setEditError(updateError.message);
      } else {
        setError(
          errorMessage(updateError, "Failed to update dataset details."),
        );
        setFailedOperation("save");
        failedDatasetIdRef.current = editDraft.id;
      }
    } finally {
      setBusyDatasetId(null);
    }
  }, [datasets, editDraft, publish, studioHost]);

  const deleteDataset = useCallback(
    async (dataset: ScenarioDatasetDto) => {
      if (
        !window.confirm(
          `Delete "${dataset.name}"? This removes the dataset and its scenarios.`,
        )
      ) {
        return;
      }
      setBusyDatasetId(dataset.id);
      setError(null);
      setFailedOperation(null);
      try {
        await studioHost.projects.deleteDataset(dataset.id);
        publish((datasets ?? []).filter((item) => item.id !== dataset.id));
        // The dataset's cached document page would otherwise outlive it and re-seed a list for a
        // dataset that no longer exists.
        delete scenarioListCache.documentsByDataset[dataset.id];
        delete scenarioListCache.pendingDocumentsByDataset[dataset.id];
        scenarioListCache.loadedDatasetIds.delete(dataset.id);
        if (scenarioListCache.selectedDatasetId === dataset.id) {
          scenarioListCache.selectedDatasetId = null;
          persistScenarioViewState();
        }
      } catch (deleteError) {
        setError(errorMessage(deleteError, "Failed to delete dataset."));
        setFailedOperation("delete");
        failedDatasetIdRef.current = dataset.id;
      } finally {
        setBusyDatasetId(null);
      }
    },
    [datasets, publish, studioHost],
  );

  const retryFailedOperation = useCallback(() => {
    if (failedOperation === "load") void loadDatasets();
    if (failedOperation === "create") void createDataset();
    if (failedOperation === "save") void saveDatasetDetails();
    if (failedOperation === "delete" && failedDatasetIdRef.current) {
      const dataset = (datasets ?? []).find(
        (item) => item.id === failedDatasetIdRef.current,
      );
      if (dataset) void deleteDataset(dataset);
    }
  }, [
    createDataset,
    datasets,
    deleteDataset,
    failedOperation,
    loadDatasets,
    saveDatasetDetails,
  ]);

  // The same condition that mounts `DatasetRenderPane` below, hoisted because the world behind the
  // pane has to react to it too.
  const renderPaneOpen = Boolean(
    openDatasetId && datasetRightPaneMode === "render" && renderTarget,
  );

  const openNewDatasetDialog = useCallback(() => {
    setError(null);
    setNewDatasetError(null);
    setNewDatasetOpen(true);
  }, []);

  const editDatasetDetails = useCallback((dataset: ScenarioDatasetDto) => {
    setError(null);
    setEditError(null);
    setEditDraft({
      id: dataset.id,
      name: dataset.name,
      description: dataset.description ?? "",
    });
  }, []);

  return (
    <ScenarioSessionProvider session={scenarioSession}>
    <section
      {...stylex.props(styles.scenarioDatasetIndex)}
      data-testid="scenario-dataset-index"
      data-workspace-mode={openDocumentId ? "editor" : datasetRightPaneMode}
    >
      {/* The surface leases the dashboard's world. The coverage renderer is
          absent while editing, rather than rendering invisibly behind it. */}
      {editing ? (
        <ScenarioWorldSurface
          {...stylex.props(styles.worldSurface)}
          target={worldTarget}
          pendingTarget={worldTarget === null}
          frameOnEnter
          interactive
          onViewerChange={setViewer}
          onActorRendererChange={setActorRenderer}
          onStateChange={setWorldState}
        />
      ) : null}

      {/* Keep the list's data and scroll position, not a second GPU scene. */}
      <div
        {...stylex.props(styles.listSession, editing && styles.hiddenSession)}
        aria-hidden={editing ? "true" : undefined}
        data-testid="scenario-list-session"
      >
        <WorkspacePanes
          storageKey={SCENARIO_LIST_WIDTH_KEY}
          railLabel="Resize the scenario list"
          railVariant="blur-gradient"
          railCollapsed={renderImmersive}
          activePane={activePane}
          onActivePaneChange={setActivePane}
          rail={
          <div {...stylex.props(styles.panelGrid)}>
            <DatasetStrip
              datasets={orderedDatasets}
              cloudHome={cloudHome}
              loading={datasets === null}
              creating={creatingDataset}
              busyDatasetId={busyDatasetId}
              activeDatasetId={openDatasetId}
              onSelectDataset={selectDataset}
              onPrefetchDataset={(datasetId) =>
                router.prefetch(datasetHref(datasetId))
              }
              onOpenNewDatasetDialog={openNewDatasetDialog}
              onEditDatasetDetails={editDatasetDetails}
              onDeleteDataset={(dataset) => void deleteDataset(dataset)}
            />
            {openDataset ? (
              <ScenarioDatasetDetailClient
                key={openDataset.id}
                dataset={openDataset}
                onEditDataset={editDatasetDetails}
                onDeleteDataset={(dataset) => void deleteDataset(dataset)}
                onEditDocument={(document) => openDocument(document.id)}
                onPreviewDocument={(document) => previewDocument(document.id)}
                onExitEdit={() => openDocument(null)}
                onRenderDocument={(document) => toggleRenderPane(document)}
                onDriveVariation={(documentId, roleId) =>
                  router.push(driveHref(documentId, roleId))
                }
                editActiveDocumentId={openDocumentId}
                renderActiveDocumentId={
                  datasetRightPaneMode === "render"
                    ? (renderTarget?.id ?? null)
                    : null
                }
                renderWorkLive={renderWorkLive}
                renderCompletionGeneration={renderCompletionGeneration}
                selectedDocumentId={previewDocumentId}
                selectedMapVersionId={selectedMapVersionId}
                onSelectMap={selectMap}
                onMapGroupsChange={setMapGroups}
              />
            ) : datasets === null ? (
              <ListSkeleton label="Loading datasets" />
            ) : (
              <EmptyState
                xstyle={styles.emptyColumn}
                title="No datasets yet"
                description="A dataset holds your scenarios. Create one to start."
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={creatingDataset}
                    onClick={openNewDatasetDialog}
                  >
                    Create dataset
                  </Button>
                }
              />
            )}
          </div>
        }
          stage={

        <div {...stylex.props(styles.divRelative)}>
          {/* The browsing surface: coverage regions, not a city. The blur is the render tab's
              treatment of whatever is behind its glass pane, unchanged from the world it replaces.
              The pane this sits in is pointer-transparent so the floating column can overlap it,
              which was all the old idle 3D scene needed — it was a picture. The coverage map is a
              control (hover a region, click to select, click bare basemap to clear), so this
              surface takes pointer events back. */}
          <div
            {...stylex.props(styles.coverageSurface, renderPaneOpen && styles.coverageBlurred)}
          >
            {!editing ? (
              <ScenarioCoverageMap
                maps={mapGroups}
                selectedMapVersionId={selectedMapVersionId}
                onSelectMap={selectMap}
                onCreateScenario={createScenarioHere}
                onDriveHere={driveHere}
                creatingScenarioMapVersionId={creatingScenarioMapVersionId}
              />
            ) : null}
          </div>
          {renderPaneOpen && renderTarget ? (
            <div {...stylex.props(styles.div)}>
              <DatasetRenderPane
                documentId={renderTarget.id}
                initialDocumentTitle={renderTarget.title || null}
                initialRevisionId={renderTarget.latestRevisionId}
                onClose={closeRenderPane}
                onRenderActivityChange={handleRenderActivityChange}
                onImmersiveChange={setRenderImmersive}
              />
            </div>
          ) : null}
          {/* Errors float over the scene rather than sitting in the rail: a failed delete belongs next to
            nothing in particular, and the rail is 220px wide — too narrow for a message plus a retry. */}
          {error && datasets !== null ? (
            <div {...stylex.props([hairline.all, styles.divAbsoluteFlex])}>
              <CopyableErrorMessage
                message={error}
                {...stylex.props(styles.copyableerrormessage)}
              />
              {failedOperation ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={retryFailedOperation}
                >
                  Try again
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
          }
        />
        <NewDatasetDialog
          open={newDatasetOpen}
          name={newDatasetName}
          busy={creatingDataset}
          error={newDatasetError}
          onNameChange={setNewDatasetName}
          onClose={() => {
            if (creatingDataset) return;
            setNewDatasetOpen(false);
            setNewDatasetName("");
            setNewDatasetError(null);
          }}
          onSubmit={() => void createDataset()}
        />
        <MetadataDetailsDialog
          open={Boolean(editDraft)}
          title="Edit dataset details"
          intro="Update the name and description shown to scenario operators."
          name={editDraft?.name ?? ""}
          description={editDraft?.description ?? ""}
          busy={Boolean(editDraft && busyDatasetId === editDraft.id)}
          error={editError}
          namePlaceholder="Dataset name"
          descriptionPlaceholder="Dataset description"
          submitLabel="Save dataset"
          onNameChange={(name) =>
            setEditDraft((current) =>
              current ? { ...current, name } : current,
            )
          }
          onDescriptionChange={(description) =>
            setEditDraft((current) =>
              current ? { ...current, description } : current,
            )
          }
          onClose={() => {
            if (busyDatasetId) return;
            setEditDraft(null);
            setEditError(null);
          }}
          onSubmit={() => void saveDatasetDetails()}
        />
      </div>

      {editing
      && openDatasetId
      && openDocumentId
      && scenarioSession.document?.id === openDocumentId
      && scenarioSession.maps ? (
        <div
          aria-busy={editorReady ? undefined : true}
          className={[stylex.props(styles.editorSession).className, editorReady ? "editor-mode-main-enter" : ""].filter(Boolean).join(" ")}
          data-editor-ready={String(editorReady)}
          data-testid="scenario-editor-session"
        >
          <ScenarioEditorClient
            key={scenarioSession.document.id}
            datasetId={openDatasetId}
            initialDocumentId={scenarioSession.document.id}
            onExitToList={() => openDocument(null)}
            injectedViewer={viewer}
            sharedActorRenderer={actorRenderer}
            active
            loadedMapVersionId={worldState.loadedMapVersionId}
            onWorldTargetChange={publishWorldTarget}
            onWorkspaceReady={revealEditor}
            initialDocument={scenarioSession.document}
            initialMaps={scenarioSession.maps}
            sharedPlayback={scenarioSession.playback}
            onSessionDocumentChange={scenarioSession.updateDocument}
          />
          {/* Browser SUMO for the edited scenario: status, signal heads and revision evidence. */}
          <ScenarioSumoTraffic session={scenarioSession} />
        </div>
      ) : null}

      {datasets === null && !editing ? (
        error ? <RouteErrorState xstyle={styles.errorCover} title="Could not load datasets" description={error} onRetry={retryFailedOperation} /> :
        <CloudLoadingSurface scope="screen" title="Loading datasets" detail="Reading this workspace." />
      ) : null}
      {editing && !editorReady ? (
        scenarioSession.failed ? (
          <RouteErrorState xstyle={styles.errorCover} title="The scenario could not be opened" description={scenarioSession.message}
            onRetry={() => window.location.reload()} exitHref="/dashboard/scenario" exitLabel="Back to scenarios" />
        ) : (
          <CloudLoadingSurface scope="screen" title="Opening the scenario" detail={scenarioSession.message ?? "Reading the scenario and its map."} />
        )
      ) : null}
    </section>
    </ScenarioSessionProvider>
  );
}
