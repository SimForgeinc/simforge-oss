"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioDatasetDetailClient.stylex";
import { useStudioHost } from "../../host";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, Search, Tags } from "lucide-react";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import type {
  ScenarioDatasetDto,
  ScenarioDocumentSummaryDto,
} from "../../lib/scenario/contracts";
import { Button } from "../../components/ui/button";
import { IconButton } from "../../components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { EmptyState } from "../../components/ui/empty-state";
import { useVisiblePolling } from "../../lib/use-visible-polling";
import { menu } from "../scenario-controls.stylex";
import { CopyableErrorMessage } from "../list/CopyableErrorMessage";
import { MetadataDetailsDialog } from "../list/MetadataDetailsDialog";
import { ScenarioDocumentCreator } from "../list/ScenarioDocumentCreator";
import { ScenarioMapPickerDialog } from "../list/ScenarioMapPickerDialog";
import { ScenarioTransferOverlay } from "../list/transfer/ScenarioTransferOverlay";
import { ScenarioTagFilterDropdown } from "../list/ScenarioTagFilterDropdown";
import {
  documentCreatorKey,
  documentName,
  documentSummaryFromDocument,
} from "../list/document-list-utils";
import {
  groupDocumentsByMap,
  type ScenarioMapGroup,
  type ScenarioMapOption,
} from "../list/document-map-groups";
import { scenarioListCache } from "../list/scenarioListCache";
import {
  hydrateScenarioViewStateFromStorage,
  rememberScenarioSelection,
} from "../list/scenarioViewState";
import { useScenarioDocumentActions } from "../list/useScenarioDocumentActions";
import { useScenarioDocumentList } from "../list/useScenarioDocumentList";
import { useScenarioTagManager } from "../list/useScenarioTagManager";
import { isDatasetEditable } from "../rail/DatasetStrip";
import { textLayout, typography } from "../../stylex/recipes.stylex";

/** Readiness refresh cadence while a render is in flight, matching v1. */
const READINESS_POLL_MS = 5_000;

/**
 * One dataset's scenario column: the right-hand half of the workspace's left panel, beside the
 * dataset strip. Slack's channel pane is the model — the dataset's name and description head the
 * column, a toolbar filters it, the rows follow, and "Add scenario" closes the list.
 *
 * It never navigates. Every action switches mode in place through the callbacks, because a route
 * change here would dispose the world scene beside the list.
 */
export function ScenarioDatasetDetailClient({
  dataset,
  onEditDataset,
  onDeleteDataset,
  onEditDocument,
  onPreviewDocument,
  onExitEdit,
  onRenderDocument,
  onDriveVariation,
  editActiveDocumentId,
  renderActiveDocumentId,
  renderWorkLive,
  renderCompletionGeneration = 0,
  selectedDocumentId,
  selectedMapVersionId,
  onSelectMap,
  onMapGroupsChange,
}: {
  dataset: ScenarioDatasetDto;
  /** Open the dataset details dialog; the header menu and the description both lead here. */
  onEditDataset: (dataset: ScenarioDatasetDto) => void;
  onDeleteDataset: (dataset: ScenarioDatasetDto) => void;
  onEditDocument: (document: ScenarioDocumentSummaryDto) => void;
  /** Select a row for world-pane preview without entering the editor. */
  onPreviewDocument: (document: ScenarioDocumentSummaryDto) => void;
  onExitEdit: () => void;
  onRenderDocument: (document: ScenarioDocumentSummaryDto) => void;
  /**
   * Leave for the drive route with the variation this dataset just created.
   *
   * The navigation belongs to the caller: this column keeps the world scene
   * beside it alive and never routes on its own.
   */
  onDriveVariation: (documentId: string, roleId: string) => void;
  editActiveDocumentId: string | null;
  renderActiveDocumentId: string | null;
  /** Render job liveness from the pane that owns the job state. Omit when unavailable. */
  renderWorkLive?: boolean;
  /** Increments when the render owner settles a scope on no live work, so badges reconcile exactly once. */
  renderCompletionGeneration?: number;
  /** The row the column shows as selected; the workspace owns it and seeds it from view state. */
  selectedDocumentId: string | null;
  /** The map group the coverage map has open, or `null` for none. */
  selectedMapVersionId: string | null;
  /** Opening or closing a group from the list side; the coverage map follows the same state. */
  onSelectMap: (mapVersionId: string | null) => void;
  /** Publishes this dataset's map grouping to the workspace, which draws it as coverage regions. */
  onMapGroupsChange: (groups: ScenarioMapGroup[]) => void;
}) {
  const studioHost = useStudioHost();
  const hydratedRef = useRef(false);
  const datasetId = dataset.id;

  // Hydrate before initializing local state. The cache is module state, so a second hydrate would
  // clobber a selection the user has already made in this session.
  if (!hydratedRef.current) {
    hydratedRef.current = true;
    hydrateScenarioViewStateFromStorage();
  }

  const [maps, setMaps] = useState<ScenarioMapOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchRevealed, setSearchRevealed] = useState(false);
  const [transferDocument, setTransferDocument] = useState<ScenarioDocumentSummaryDto | null>(null);
  // An active query keeps the field on screen: hiding it would filter the list
  // with nothing on screen saying why rows are missing.
  const searchOpen = searchRevealed || query.length > 0;

  const reportError = useCallback((errorValue: unknown, fallback: string) => {
    setError(errorValue instanceof Error ? errorValue.message : fallback);
  }, []);

  const list = useScenarioDocumentList(datasetId);
  const hasReliableRenderLiveness = renderWorkLive !== undefined;
  const [readinessLoadedDatasetId, setReadinessLoadedDatasetId] = useState<string | null>(null);
  const [reconciledCompletion, setReconciledCompletion] = useState(() => ({
    datasetId,
    generation: renderCompletionGeneration,
  }));

  useEffect(() => {
    // Refetch whenever this list is the visible surface, not just on mount: the editor is where
    // documents change, so the list's copy is the one most likely to be stale, and the list stays
    // mounted-but-hidden behind the editor rather than unmounting (see ScenarioDatasetsClient).
    //
    // Concretely, a summary projected at create time reports no sensor profile — a new scenario has
    // no actors yet — and nothing re-derived it when the author fitted a sensor, so the row's render
    // affordance stayed disabled for the rest of the session. Cached and server-rendered rows are
    // the first paint, not the answer.
    //
    // This does not weaken the splice-only rule (§5.6): it fires when a dataset opens and when the
    // editor closes, both of which are single-page states, never after a rename or a tag edit, so
    // no later page can be dropped under the user.
    if (editActiveDocumentId) return;
    void list.loadFirstPage();
    // `list` is a fresh object each render; keying on the ids is what makes this fire once per
    // dataset and once per editor close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, editActiveDocumentId]);

  useEffect(() => {
    const abort = new AbortController();
    void studioHost.artifacts.listMaps(abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setMaps(next);
      })
      .catch(() => {
        // The map catalog only gates "New Scenario"; the list itself is still usable without it.
      });
    return () => abort.abort();
  }, [studioHost]);

  const tagManager = useScenarioTagManager({
    datasetId,
    documents: list.documents,
    spliceDocument: list.spliceDocument,
  });

  const actions = useScenarioDocumentActions({
    datasetId,
    maps,
    reportError,
    spliceDocument: list.spliceDocument,
    removeDocument: list.removeDocument,
    onOpenDocument: (_datasetId, _documentId, document) => {
      if (document) onEditDocument(document);
    },
  });

  // `resolveScenarioDatasetAccess` is the enforcement; this is the display hint that keeps the
  // affordances honest, derived from the same two fields (§6.5).
  const datasetEditable = isDatasetEditable(dataset);

  const creatorOptions = useMemo(() => {
    const counts = new Map<
      string,
      { value: string; label: string; count: number }
    >();
    for (const document of list.documents) {
      const creator = documentCreatorKey(document);
      if (!creator) continue;
      const current = counts.get(creator);
      counts.set(creator, {
        value: creator,
        label: creator,
        count: (current?.count ?? 0) + 1,
      });
    }
    return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [list.documents]);

  const activeTagFilter = tagManager.selectedTagFilter;
  const activeCreatorFilter = tagManager.selectedCreatorFilter;
  const needle = query.trim().toLowerCase();

  const visibleDocuments = useMemo(() => {
    if (!activeTagFilter && !activeCreatorFilter && !needle) return list.documents;
    return list.documents
      .filter((document) => {
        if (
          activeTagFilter &&
          !document.tags.some((tag) => tag.id === activeTagFilter)
        ) {
          return false;
        }
        if (
          activeCreatorFilter &&
          documentCreatorKey(document) !== activeCreatorFilter
        ) {
          return false;
        }
        return !needle || documentName(document).toLowerCase().includes(needle);
      })
      .sort((a, b) => documentName(a).localeCompare(documentName(b)));
  }, [activeCreatorFilter, activeTagFilter, list.documents, needle]);

  /**
   * The one grouping of this dataset's scenarios by map.
   *
   * The column renders it as collapsible groups and the workspace draws the same groups as coverage
   * regions, so it is computed here — the only place that holds both the filtered rows and the map
   * catalog — and published upward rather than derived twice from two different inputs.
   */
  const documentGroups = useMemo(
    () => groupDocumentsByMap(visibleDocuments, maps),
    [maps, visibleDocuments],
  );
  const onMapGroupsChangeRef = useRef(onMapGroupsChange);
  onMapGroupsChangeRef.current = onMapGroupsChange;
  useEffect(() => {
    onMapGroupsChangeRef.current(documentGroups);
  }, [documentGroups]);

  const renderInProgress = renderWorkLive === true;
  const completionPending =
    hasReliableRenderLiveness &&
    reconciledCompletion.datasetId === datasetId &&
    reconciledCompletion.generation !== renderCompletionGeneration;
  const initialReadinessPending = readinessLoadedDatasetId !== datasetId;
  const pollReadiness = useCallback(async (signal: AbortSignal) => {
    const loaded = await list.loadReadiness(signal);
    if (!loaded || signal.aborted) return;
    setReadinessLoadedDatasetId(datasetId);
    if (hasReliableRenderLiveness && !renderWorkLive) {
      setReconciledCompletion({
        datasetId,
        generation: renderCompletionGeneration,
      });
    }
    // `list` is a fresh object each render; the dataset and render ownership
    // inputs are the callback's actual resource identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    datasetId,
    hasReliableRenderLiveness,
    renderCompletionGeneration,
    renderWorkLive,
  ]);
  // Standalone routes do not own render-job state, so they retain the existing
  // five-second polling for correctness. The integrated surface stops after
  // its initial snapshot and resumes only while its render owner reports live
  // work, with one keyed reconciliation each time the owner settles a scope on
  // no live work — after completion, or on opening a scope that already finished.
  useVisiblePolling(
    pollReadiness,
    READINESS_POLL_MS,
    !editActiveDocumentId &&
      list.loaded &&
      list.documents.length > 0 &&
      (!hasReliableRenderLiveness ||
        initialReadinessPending ||
        renderWorkLive === true ||
        completionPending),
    `${datasetId}:${hasReliableRenderLiveness ? renderCompletionGeneration : "unowned"}`,
  );

  const toggleTagEditor = useCallback(() => {
    setTagEditorOpen((open) => !open);
  }, []);

  const toggleSearch = useCallback(() => {
    setSearchRevealed((revealed) => {
      if (revealed) setQuery("");
      return !revealed;
    });
  }, []);

  // Create the variation, then hand the drive to the route. A refusal — no drivable actor, an
  // unpinned scenario — is already reported by the action, so there is nothing to navigate to.
  const startDriverInTheLoop = useCallback(
    async (document: ScenarioDocumentSummaryDto) => {
      const started = await actions.startDriverInTheLoop(document);
      if (started) onDriveVariation(started.documentId, started.roleId);
    },
    [actions, onDriveVariation],
  );

  const selectDocument = useCallback(
    (document: ScenarioDocumentSummaryDto) => {
      rememberScenarioSelection(datasetId, document.id);
      onPreviewDocument(document);
    },
    [datasetId, onPreviewDocument],
  );

  const combinedError = error ?? list.error ?? tagManager.tagError;
  const addBusy = actions.creatingDocument || actions.importingDocument;
  const addScenarioMenu = (
    <DropdownMenuContent align="start" xstyle={menu.width210}>
      <DropdownMenuItem
        disabled={actions.creatingDocument || maps.length === 0}
        onSelect={() => actions.setMapPickerOpen(true)}
      >
        New Scenario
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={actions.importingDocument}
        onSelect={() => actions.importInputRef.current?.click()}
      >
        Import Scenario JSON
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
  const listEmpty = list.loaded && !list.loading && list.documents.length === 0;

  return (
    <section
      {...stylex.props(styles.column)}
      data-testid="scenario-document-index"
      data-dataset-id={datasetId}
    >
      <header
        {...stylex.props(styles.header)}
        data-testid="scenario-scenario-list-header"
      >
        <div {...stylex.props(styles.titleRow)}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                {...stylex.props(styles.titleButton)}
                aria-label={`${dataset.name} dataset menu`}
              >
                <h2 {...stylex.props([textLayout.truncate, styles.title])}>{dataset.name}</h2>
                <ChevronDown {...stylex.props(styles.titleChevron)} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" xstyle={menu.width210}>
              <DropdownMenuItem
                disabled={!datasetEditable}
                onSelect={() => onEditDataset(dataset)}
              >
                Edit details
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void navigator.clipboard?.writeText(dataset.id)}
              >
                Copy dataset id
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!datasetEditable}
                xstyle={menu.destructiveItem}
                onSelect={() => onDeleteDataset(dataset)}
              >
                Delete dataset
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div {...stylex.props(styles.headerActions)}>
            <IconButton
              label={searchOpen ? "Hide scenario search" : "Search scenarios"}
              variant="plate"
              size="md"
              active={searchOpen}
              onClick={toggleSearch}
            >
              <Search />
            </IconButton>
            <ScenarioTagFilterDropdown
              tags={tagManager.tags}
              creatorOptions={creatorOptions}
              selectedTagFilter={tagManager.selectedTagFilter}
              selectedCreatorFilter={tagManager.selectedCreatorFilter}
              onSelectTagFilter={tagManager.selectTagFilter}
              onSelectCreatorFilter={tagManager.selectCreatorFilter}
            />
            <IconButton
              label={tagEditorOpen ? "Close tag editor" : "Edit tags"}
              variant="plate"
              size="md"
              active={tagEditorOpen}
              onClick={toggleTagEditor}
            >
              <Tags />
            </IconButton>
            {datasetEditable ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="iconSm"
                    variant="ghost"
                    xstyle={styles.headerAdd}
                    aria-label="Add scenario"
                    data-testid="scenario-add-scenario"
                  >
                    {addBusy ? (
                      <CloudActivityIndicator />
                    ) : (
                      <Plus {...stylex.props(styles.plusIcon)} aria-hidden="true" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                {addScenarioMenu}
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        <p
          {...stylex.props(
            styles.description,
            dataset.description ? null : styles.descriptionEmpty,
          )}
          data-testid="scenario-dataset-description"
        >
          {dataset.description || "No description"}
        </p>
        {searchOpen ? (
          <div {...stylex.props(styles.toolbar)}>
            <div {...stylex.props(styles.searchField)}>
              <Search {...stylex.props(styles.searchIcon)} aria-hidden="true" />
              <input
                // Opening the field is the request to type in it.
                autoFocus
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Filter scenarios"
                aria-label="Filter scenarios by name"
                {...stylex.props(styles.searchInput)}
              />
            </div>
          </div>
        ) : null}
      </header>
      {combinedError || notice ? (
        <div {...stylex.props(styles.messages)}>
          {combinedError ? (
            <div {...stylex.props(styles.messageRow)}>
              <CopyableErrorMessage
                message={combinedError}
                {...stylex.props(styles.messageText)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setError(null);
                  list.clearError();
                  tagManager.clearTagError();
                  void list.loadFirstPage();
                }}
              >
                Refresh
              </Button>
              {actions.importTransfer ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="import-transfer-confirm"
                  onClick={() => {
                    setError(null);
                    actions.confirmImportTransfer();
                  }}
                >
                  Transfer onto {actions.importTransfer.target.label} ({actions.importTransfer.target.mapVersionId})
                </Button>
              ) : null}
            </div>
          ) : null}
          {notice ? (
            <p
              {...stylex.props([typography.eyebrow, styles.status])}
              role="status"
            >
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}

      <div {...stylex.props(styles.body)}>
        {listEmpty && !tagEditorOpen ? (
          <EmptyState
            xstyle={styles.emptyState}
            title="No scenarios yet"
            description={
              datasetEditable
                ? "Add a scenario to start building this dataset."
                : "This shared dataset has no scenarios."
            }
            action={
              datasetEditable ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" disabled={addBusy}>
                      <Plus {...stylex.props(styles.plusIcon)} aria-hidden="true" />
                      Add scenario
                    </Button>
                  </DropdownMenuTrigger>
                  {addScenarioMenu}
                </DropdownMenu>
              ) : undefined
            }
          />
        ) : (
          <ScenarioDocumentCreator
            datasetId={datasetId}
            datasetEditable={datasetEditable}
            documents={visibleDocuments}
            totalDocumentCount={list.documents.length}
            documentsLoading={!list.loaded || list.loading}
            documentsLoadingMore={list.loadingMore}
            hasMoreDocuments={list.hasMore}
            onLoadMoreDocuments={() => void list.loadMore()}
            documentGroups={documentGroups}
            expandedMapVersionId={selectedMapVersionId}
            onToggleMapGroup={(mapVersionId) =>
              onSelectMap(selectedMapVersionId === mapVersionId ? null : mapVersionId)
            }
            advancedMode
            tagEditorMode={tagEditorOpen}
            tags={tagManager.tags}
            ratingAggregates={tagManager.ratingAggregates}
            ratingsLoading={tagManager.ratingsLoading}
            ratingError={tagManager.ratingError}
            ratingSavingIds={tagManager.ratingSavingIds}
            selectedTagFilter={activeTagFilter}
            newTagName={tagManager.newTagName}
            newTagColor={tagManager.newTagColor}
            onNewTagNameChange={tagManager.setNewTagName}
            onNewTagColorChange={tagManager.setNewTagColor}
            onCreateTag={() => void tagManager.createTag()}
            onRenameTag={(tagId, label) =>
              void tagManager.renameTag(tagId, label)
            }
            onSetTagColor={(tagId, color) =>
              void tagManager.setTagColor(tagId, color)
            }
            onDeleteTag={(tagId) => void tagManager.deleteTag(tagId)}
            onSelectTagFilter={tagManager.selectTagFilter}
            onAssignTag={(documentId, tagId) =>
              void tagManager.assignDocumentTag(documentId, tagId)
            }
            onSetRating={(documentId, rating) =>
              void tagManager.setDocumentRating(documentId, rating)
            }
            activeDocumentId={selectedDocumentId}
            renderActiveDocumentId={renderActiveDocumentId ?? null}
            busyDocumentId={actions.busyDocumentId}
            renamingDocumentId={actions.renamingDocumentId}
            renameDraft={actions.renameDraft}
            renderInProgress={renderInProgress}
            onClearDraggingTag={() => {}}
            onRenameDraftChange={actions.setRenameDraft}
            onSetRenamingDocumentId={actions.setRenamingDocumentId}
            onCommitRename={(document, draft) =>
              void actions.commitRename(document, draft)
            }
            onOpenDocument={selectDocument}
            onEditDocument={onEditDocument}
            onExitEdit={onExitEdit}
            onRenderDocument={onRenderDocument}
            onDriverInTheLoop={(document) => void startDriverInTheLoop(document)}
            editActiveDocumentId={editActiveDocumentId}
            onDownloadDocument={(document) =>
              void actions.downloadDocument(document)
            }
            onDuplicateDocument={(document) =>
              void actions.duplicateDocument(document)
            }
            onTransferDocument={setTransferDocument}
            onEditDetails={actions.startEditDetails}
            onDeleteDocument={(document) =>
              void actions.deleteDocument(document)
            }
            onError={reportError}
            onNotice={setNotice}
          />
        )}
      </div>

      {datasetEditable ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="lg"
              type="button"
              variant="outline"
              xstyle={styles.footerAdd}
              disabled={addBusy}
              data-testid="scenario-add-scenario-row"
            >
              <span {...stylex.props(styles.footerAddIcon)} aria-hidden="true">
                {addBusy ? (
                  <CloudActivityIndicator />
                ) : (
                  <Plus {...stylex.props(styles.plusIcon)} />
                )}
              </span>
              Add scenario
            </Button>
          </DropdownMenuTrigger>
          {addScenarioMenu}
        </DropdownMenu>
      ) : null}

      <input
        ref={actions.importInputRef}
        aria-label="Import scenario JSON file"
        {...stylex.props(styles.importScenarioJSONFileInput)}
        type="file"
        accept=".json,application/json"
        onChange={actions.handleImportFile}
      />
      <ScenarioMapPickerDialog
        maps={maps}
        currentMapVersionId={null}
        open={actions.mapPickerOpen}
        onOpenChange={actions.setMapPickerOpen}
        onSelectMap={(map) => void actions.createDocumentOnMap(map)}
      />
      <ScenarioTransferOverlay
        document={transferDocument}
        onClose={() => setTransferDocument(null)}
        onCreated={actions.recordTransferredDocument}
        onOpenDocument={(created) =>
          onEditDocument({
            ...documentSummaryFromDocument(created),
            derivationKind: "cross_map_variation",
            derivedFromDocumentId: transferDocument?.id ?? null,
          })
        }
      />
      <MetadataDetailsDialog
        open={Boolean(actions.detailsDraft)}
        title="Edit scenario details"
        intro="Update the name and description shown in the dataset scenario list."
        name={actions.detailsDraft?.name ?? ""}
        description={actions.detailsDraft?.description ?? ""}
        busy={Boolean(
          actions.detailsDraft &&
          actions.busyDocumentId === actions.detailsDraft.id,
        )}
        error={actions.detailsError}
        namePlaceholder="Scenario name"
        descriptionPlaceholder="Scenario description"
        submitLabel="Save scenario"
        onNameChange={(name) =>
          actions.setDetailsDraft((current) =>
            current ? { ...current, name } : current,
          )
        }
        onDescriptionChange={(description) =>
          actions.setDetailsDraft((current) =>
            current ? { ...current, description } : current,
          )
        }
        onClose={actions.closeDetailsDialog}
        onSubmit={() => void actions.saveDetails()}
      />
    </section>
  );
}
