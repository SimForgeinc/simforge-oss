"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioDocumentCreator.stylex";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ChevronDown, MoreHorizontal, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import type {
  ScenarioDocumentSummaryDto,
  ScenarioRatingAggregateDto,
  ScenarioTagDto,
} from "../../lib/scenario/contracts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { CloudActivityIndicator, CloudLoadingSurface } from "../../components/CloudLoadingSurface";
import { cn } from "../../lib/utils";
import { list, paneLoading } from "../scenario-controls.stylex";
import {
  groupVariationsBySource,
  type ScenarioMapGroup,
} from "./document-map-groups";
import { SCENARIO_TAG_DRAG_MIME, ScenarioDocumentRow } from "./ScenarioDocumentRow";
import {
  DEFAULT_SCENARIO_TAG_COLOR,
  DEFAULT_SCENARIO_TAG_COLORS,
} from "./scenarioListCache";
import { focus, textLayout } from "../../stylex/recipes.stylex";

type SharedRowHandlers = Pick<
  React.ComponentProps<typeof ScenarioDocumentRow>,
  | "onAssignTag"
  | "onRenameDraftChange"
  | "onSetRenamingDocumentId"
  | "onCommitRename"
  | "onOpenDocument"
  | "onEditDocument"
  | "onExitEdit"
  | "onRenderDocument"
  | "onDriverInTheLoop"
  | "onDownloadDocument"
  | "onDuplicateDocument"
  | "onTransferDocument"
  | "onEditDetails"
  | "onDeleteDocument"
  | "onError"
  | "onNotice"
  | "onClearDraggingTag"
>;

export type ScenarioDocumentCreatorProps = SharedRowHandlers & {
  datasetId: string;
  datasetEditable: boolean;
  documents: ScenarioDocumentSummaryDto[];
  totalDocumentCount: number;
  documentsLoading: boolean;
  documentsLoadingMore: boolean;
  hasMoreDocuments: boolean;
  onLoadMoreDocuments: () => void;
  /** This dataset's rows grouped by map, owned by the workspace so the coverage map shares it. */
  documentGroups: ScenarioMapGroup[];
  /** The one open group, or `null` for none. */
  expandedMapVersionId: string | null;
  onToggleMapGroup: (mapVersionId: string) => void;
  advancedMode: boolean;
  tagEditorMode: boolean;
  tags: ScenarioTagDto[];
  ratingAggregates: Record<string, ScenarioRatingAggregateDto>;
  ratingsLoading: boolean;
  ratingError: string | null;
  ratingSavingIds: ReadonlySet<string>;
  selectedTagFilter: string | null;
  newTagName: string;
  newTagColor: string;
  onNewTagNameChange: (next: string) => void;
  onNewTagColorChange: (next: string) => void;
  onCreateTag: () => void;
  onRenameTag: (tagId: string, label: string) => void;
  onSetTagColor: (tagId: string, color: string) => void;
  onDeleteTag: (tagId: string) => void;
  onSelectTagFilter: (tagId: string | null) => void;
  onSetRating: (documentId: string, rating: number) => void;
  activeDocumentId: string | null | undefined;
  /** The document open in the editor, if any. Drives the pencil's toggled state. */
  editActiveDocumentId?: string | null;
  renderActiveDocumentId?: string | null;
  busyDocumentId: string | null;
  renamingDocumentId: string | null;
  renameDraft: string;
  renderInProgress: boolean;
};

/**
 * The document list body: map groups, the tag rail, the load-more control.
 *
 * Ported from v1's `ScenarioCreator`. One group is open at a time — opening another closes the first —
 * which is what makes the map cards readable as a table of contents rather than as a wall.
 */
export function ScenarioDocumentCreator({
  datasetId,
  datasetEditable,
  documents,
  totalDocumentCount,
  documentsLoading,
  documentsLoadingMore,
  hasMoreDocuments,
  onLoadMoreDocuments,
  documentGroups,
  expandedMapVersionId,
  onToggleMapGroup,
  advancedMode,
  tagEditorMode,
  tags,
  ratingAggregates,
  ratingsLoading,
  ratingError,
  ratingSavingIds,
  selectedTagFilter,
  newTagName,
  newTagColor,
  onNewTagNameChange,
  onNewTagColorChange,
  onCreateTag,
  onRenameTag,
  onSetTagColor,
  onDeleteTag,
  onSelectTagFilter,
  onSetRating,
  activeDocumentId,
  editActiveDocumentId,
  renderActiveDocumentId,
  busyDocumentId,
  renamingDocumentId,
  renameDraft,
  renderInProgress,
  ...rowHandlers
}: ScenarioDocumentCreatorProps) {
  const showTagEditorTools = advancedMode && tagEditorMode;
  const variationsBySource = useMemo(() => groupVariationsBySource(documents), [documents]);
  const [expandedVariationRootIds, setExpandedVariationRootIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [draggingTagId, setDraggingTagId] = useState<string | null>(null);
  const draggingTagIdRef = useRef<string | null>(null);

  const beginTagDrag = (tagId: string) => {
    draggingTagIdRef.current = tagId;
    setDraggingTagId(tagId);
  };
  const clearTagDrag = () => {
    draggingTagIdRef.current = null;
    setDraggingTagId(null);
  };

  // A pointer drag can end anywhere — including outside the window — so the drag latch is cleared
  // from the window, not from the row that happened to be under the cursor.
  useEffect(() => {
    if (!draggingTagId) return;
    window.addEventListener("pointerup", clearTagDrag);
    window.addEventListener("pointercancel", clearTagDrag);
    return () => {
      window.removeEventListener("pointerup", clearTagDrag);
      window.removeEventListener("pointercancel", clearTagDrag);
    };
  }, [draggingTagId]);

  useEffect(() => {
    if (!advancedMode) clearTagDrag();
  }, [advancedMode]);

  const anyMapExpanded = expandedMapVersionId !== null;

  const toggleVariationsFor = (document: ScenarioDocumentSummaryDto) => {
    setExpandedVariationRootIds((current) => {
      const next = new Set(current);
      if (next.has(document.id)) next.delete(document.id);
      else next.add(document.id);
      return next;
    });
  };

  const renderRow = (
    document: ScenarioDocumentSummaryDto,
    options: { labelByMap?: boolean; nested?: boolean } = {},
  ) => {
    const variations = options.nested ? [] : (variationsBySource.get(document.id) ?? []);
    const variationsExpanded = variations.length > 0 && expandedVariationRootIds.has(document.id);
    const row = (
      <ScenarioDocumentRow
        key={document.id}
        document={document}
        datasetId={datasetId}
        active={document.id === activeDocumentId}
        advancedMode={advancedMode}
        tagEditorMode={tagEditorMode}
        mutable={datasetEditable}
        busy={busyDocumentId === document.id}
        renaming={renamingDocumentId === document.id}
        renameDraft={renameDraft}
        editActive={Boolean(editActiveDocumentId) && editActiveDocumentId === document.id}
        renderActive={renderActiveDocumentId === document.id}
        renderDimmed={
          Boolean(renderActiveDocumentId) && renderActiveDocumentId !== document.id
        }
        renderInProgress={renderInProgress}
        labelByMap={options.labelByMap ?? false}
        variationCount={variations.length}
        variationsExpanded={variationsExpanded}
        availableTags={tags}
        ratingAggregate={ratingAggregates[document.id]}
        ratingLoading={ratingsLoading}
        ratingSaving={ratingSavingIds.has(document.id)}
        ratingError={ratingError}
        draggingTagId={draggingTagId}
        draggingTagIdRef={draggingTagIdRef}
        onSetRating={(rating) => onSetRating(document.id, rating)}
        onToggleVariations={options.nested ? undefined : toggleVariationsFor}
        {...rowHandlers}
      />
    );
    if (!variationsExpanded) return row;
    return (
      <div key={document.id} data-scenario-with-variations="">
        {row}
        <div
          {...stylex.props(styles.div)}
          data-scenario-variations-sublist=""
        >
          {/* One nesting level. A variation of a variation is still listed under its own source. */}
          {variations.map((variation) => renderRow(variation, { labelByMap: true, nested: true }))}
        </div>
      </div>
    );
  };

  return (
    <div
      className={cn("flex h-full min-h-0", showTagEditorTools ? "flex-row" : "flex-col")}
      data-scenario-advanced-mode={advancedMode ? "" : undefined}
    >
      {showTagEditorTools ? (
        <ScenarioTagTools
          tags={tags}
          documentCount={totalDocumentCount}
          visibleDocumentCount={documents.length}
          selectedTagFilter={selectedTagFilter}
          tagEditorMode={tagEditorMode}
          newTagName={newTagName}
          newTagColor={newTagColor}
          onNewTagNameChange={onNewTagNameChange}
          onNewTagColorChange={onNewTagColorChange}
          onCreateTag={onCreateTag}
          onRenameTag={onRenameTag}
          onSetTagColor={onSetTagColor}
          onDeleteTag={onDeleteTag}
          onSelectTagFilter={onSelectTagFilter}
          onBeginTagDrag={beginTagDrag}
        />
      ) : null}
      <div {...stylex.props(styles.divFlex)}>
        {!datasetEditable ? (
          <div {...stylex.props(styles.div2)}>
            <div {...stylex.props(styles.thisIsASharedOrReadOnlyDatas)}>
              This is a shared or read-only dataset. Open scenarios from it, or copy one into a
              workspace dataset before editing.
            </div>
          </div>
        ) : null}
        <div {...stylex.props(styles.scenarioDocumentList)} data-testid="scenario-document-list">
          {documentsLoading && documents.length === 0 ? (
            <CloudLoadingSurface
          scope="pane"
              xstyle={paneLoading.h24}
              detail="Reading scenarios and their saved revisions."
              title="Loading scenarios"
            />
          ) : documents.length === 0 ? (
            <div {...stylex.props(styles.divSm)}>
              {totalDocumentCount > 0
                ? "No scenarios match the current filter."
                : "No scenarios in this dataset yet."}
            </div>
          ) : (
            <div {...stylex.props(styles.div3)}>
              {documentGroups.map((group) => (
                <MapDocumentGroup
                  key={group.groupKey}
                  group={group}
                  advancedMode={advancedMode}
                  expanded={group.mapVersionId === expandedMapVersionId}
                  anyMapExpanded={anyMapExpanded}
                  onToggle={() => onToggleMapGroup(group.mapVersionId)}
                >
                  {group.documents.map((document) => renderRow(document))}
                </MapDocumentGroup>
              ))}
              {hasMoreDocuments ? (
                <div {...stylex.props(styles.div4)}>
                  <Button
                    type="button"
                    variant="ghost"
                    xstyle={list.loadMore}
                    disabled={documentsLoadingMore}
                    onClick={onLoadMoreDocuments}
                  >
                    {documentsLoadingMore ? (
                      <CloudActivityIndicator label="Loading scenarios…" />
                    ) : "Load 50 more scenarios"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MapDocumentGroup({
  group,
  advancedMode,
  expanded,
  anyMapExpanded,
  onToggle,
  children,
}: {
  group: ScenarioMapGroup;
  advancedMode: boolean;
  expanded: boolean;
  anyMapExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  // Opening a group can come from the coverage map, where the group may be anywhere in the column —
  // including below the fold. Scrolling the card itself into view is what makes a click on a region
  // land on its scenarios rather than on an unchanged-looking list.
  useEffect(() => {
    if (expanded) sectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [expanded]);

  return (
    <section
      ref={sectionRef}
      data-scenario-map-group=""
      data-map-version-id={group.mapVersionId || undefined}
      className={cn(
        "border-b border-white/15",
        anyMapExpanded && expanded ? "border-white/25" : null,
      )}
    >
      <button
        type="button"
        data-scenario-map-card=""
        aria-expanded={expanded}
        className={cn(
          "group/map relative w-full bg-transparent text-left transition-colors hover:text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
          advancedMode ? "min-h-[56px]" : "min-h-[64px]",
        )}
        onClick={onToggle}
      >
        <div
          className={cn(
            "flex min-h-[inherit] items-end justify-between gap-3 px-3",
            advancedMode ? "py-2" : "py-3",
          )}
        >
          <div {...stylex.props(styles.div5)}>
            <div {...stylex.props([textLayout.truncate, styles.divTruncateSmSemibold])}>
              {group.displayLabel}
            </div>
            <div {...stylex.props(styles.divMetaMicroUppercase)}>
              {group.documents.length} {group.documents.length === 1 ? "scenario" : "scenarios"}
            </div>
          </div>
          <span className="flex size-7 shrink-0 items-center justify-center text-foreground/70 transition-transform group-aria-expanded/map:rotate-180 motion-reduce:transition-none">
            <ChevronDown {...stylex.props(styles.chevrondownIcon)} aria-hidden="true" />
          </span>
        </div>
      </button>
      {expanded ? (
        <div
          data-scenario-group-body=""
          {...stylex.props(styles.div6)}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The tag rail: create, recolour, rename, delete, filter, and drag onto a row.
 *
 * Two modes on one rail, as in v1. In filter mode a tag is a button that narrows the list; in editor
 * mode it is a draggable handle and clicking it does nothing, because the same gesture cannot mean
 * both "show me these" and "apply this".
 */
function ScenarioTagTools({
  tags,
  documentCount,
  visibleDocumentCount,
  selectedTagFilter,
  tagEditorMode,
  newTagName,
  newTagColor,
  onNewTagNameChange,
  onNewTagColorChange,
  onCreateTag,
  onRenameTag,
  onSetTagColor,
  onDeleteTag,
  onSelectTagFilter,
  onBeginTagDrag,
}: {
  tags: ScenarioTagDto[];
  documentCount: number;
  visibleDocumentCount: number;
  selectedTagFilter: string | null;
  tagEditorMode: boolean;
  newTagName: string;
  newTagColor: string;
  onNewTagNameChange: (next: string) => void;
  onNewTagColorChange: (next: string) => void;
  onCreateTag: () => void;
  onRenameTag: (tagId: string, label: string) => void;
  onSetTagColor: (tagId: string, color: string) => void;
  onDeleteTag: (tagId: string) => void;
  onSelectTagFilter: (tagId: string | null) => void;
  onBeginTagDrag: (tagId: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState("");
  const [openTagMenuId, setOpenTagMenuId] = useState<string | null>(null);

  const commitTagRename = () => {
    if (!editingTagId) return;
    onRenameTag(editingTagId, editingTagName);
    setEditingTagId(null);
    setEditingTagName("");
  };

  return (
    <aside
      className={cn(
        "min-h-0 w-[152px] shrink-0 overflow-y-auto border-r p-2 transition-colors",
        tagEditorMode ? "border-primary/80 bg-primary/10" : "border-white/10 bg-black/20",
      )}
      data-scenario-tag-tools-mode={tagEditorMode ? "editor" : "filter"}
    >
      <div {...stylex.props(styles.div7)}>
        <section {...stylex.props(styles.sectionRelative)}>
          <div {...stylex.props(styles.divFlex2)}>
            <div {...stylex.props(styles.divFlexMetaMicro)}>
              <Tags {...stylex.props(styles.tagsIcon)} aria-hidden="true" />
              {tagEditorMode ? "Add Tags" : "Filter"}
            </div>
            {tagEditorMode ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                xstyle={list.tagAdd}
                aria-label="Add scenario tag"
                aria-expanded={createOpen}
                onClick={() => setCreateOpen((open) => !open)}
              >
                <Plus {...stylex.props(styles.plusIcon)} aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          {tagEditorMode && createOpen ? (
            <form
              data-testid="scenario-tag-create-form"
              {...stylex.props(styles.scenarioTagCreateForm)}
              onSubmit={(event) => {
                event.preventDefault();
                onCreateTag();
                setCreateOpen(false);
              }}
            >
              <div {...stylex.props(styles.divFlex3)}>
                <Input
                  autoFocus
                  type="text"
                  aria-label="New tag name"
                  value={newTagName}
                  onChange={(event) => onNewTagNameChange(event.target.value)}
                  placeholder="Create tag"
                  xstyle={list.tagNameInput}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  xstyle={list.tagSubmit}
                >
                  Add
                </Button>
              </div>
              <ScenarioTagColorPicker
                selectedColor={newTagColor}
                onSelectColor={onNewTagColorChange}
                label="New tag color"
              />
            </form>
          ) : null}
        </section>

        <section {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.divMetaMicroUppercase2)}>
            {tagEditorMode ? "Drag tags" : "Sort by tags"}
          </div>
          <p {...stylex.props(styles.pMeta)}>
            {tagEditorMode
              ? "Drag a tag onto a scenario row to assign it."
              : "Click a tag to filter the scenario list."}
          </p>
          {!tagEditorMode ? (
            <Button
              type="button"
              variant={selectedTagFilter === null ? "default" : "outline"}
              onClick={() => onSelectTagFilter(null)}
              xstyle={list.allScenarios}
            >
              All scenarios
            </Button>
          ) : null}
          <div {...stylex.props(styles.divFlex4)}>
            {tags.length === 0 ? (
              <div {...stylex.props(styles.divXs)}>
                {tagEditorMode
                  ? "Create tags, then drag them onto scenario rows."
                  : "Create tags from Add Tags to filter scenarios."}
              </div>
            ) : (
              tags.map((tag) => {
                const color = tag.color ?? DEFAULT_SCENARIO_TAG_COLOR;
                const isFilter = selectedTagFilter === tag.id;
                return (
                  <div
                    key={tag.id}
                    draggable={tagEditorMode && editingTagId !== tag.id}
                    onPointerDown={(event) => {
                      if (!tagEditorMode || event.button !== 0 || editingTagId === tag.id) return;
                      onBeginTagDrag(tag.id);
                      setOpenTagMenuId(null);
                    }}
                    onDragStart={(event) => {
                      if (!tagEditorMode || editingTagId === tag.id) return;
                      startTagDrag(event, tag, onBeginTagDrag);
                    }}
                    className={cn(
                      "inline-flex min-h-8 w-full max-w-full items-center gap-1 border py-1 pl-3 pr-1 text-left text-xs transition-colors",
                      tagEditorMode ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                    )}
                    style={
                      isFilter
                        ? {
                            borderColor: "hsl(var(--primary))",
                            backgroundColor: "hsl(var(--primary))",
                            color: "hsl(var(--primary-foreground))",
                          }
                        : {
                            borderColor: `color-mix(in srgb, ${color} 38%, transparent)`,
                            backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
                            color,
                          }
                    }
                    data-scenario-tag-id={tag.id}
                  >
                    {editingTagId === tag.id ? (
                      <input
                        autoFocus
                        value={editingTagName}
                        onChange={(event) => setEditingTagName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitTagRename();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingTagId(null);
                            setEditingTagName("");
                          }
                        }}
                        onBlur={commitTagRename}
                        aria-label={`Rename the ${tag.label} tag`}
                        {...stylex.props([focus.ring, styles.renameTheInput])}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelectTagFilter(tag.id)}
                        disabled={tagEditorMode}
                        aria-pressed={isFilter}
                        {...stylex.props([textLayout.truncate, styles.buttonTruncate])}
                      >
                        {tag.label}
                      </button>
                    )}
                    {tagEditorMode ? (
                      <div {...stylex.props(styles.divRelative)}>
                        <button
                          type="button"
                          // The chip itself starts a drag on pointerdown, so the menu button has to
                          // stop the event or opening the menu also arms a drag.
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() =>
                            setOpenTagMenuId((current) => (current === tag.id ? null : tag.id))
                          }
                          aria-label={`Tag actions for ${tag.label}`}
                          aria-expanded={openTagMenuId === tag.id}
                          {...stylex.props([focus.ring, styles.tagActionsForButton])}
                        >
                          <MoreHorizontal {...stylex.props(styles.morehorizontalIcon)} aria-hidden="true" />
                        </button>
                        {openTagMenuId === tag.id ? (
                          <div {...stylex.props(styles.divAbsolute)}>
                            <ScenarioTagColorPicker
                              selectedColor={color}
                              onSelectColor={(nextColor) => onSetTagColor(tag.id, nextColor)}
                              label={`Color for ${tag.label}`}
                            />
                            <button
                              type="button"
                              {...stylex.props([focus.ring, styles.buttonFlexXs])}
                              onClick={() => {
                                setEditingTagId(tag.id);
                                setEditingTagName(tag.label);
                                setOpenTagMenuId(null);
                              }}
                            >
                              <Pencil {...stylex.props(styles.renamePencil)} aria-hidden="true" />
                              Rename
                            </button>
                            <button
                              type="button"
                              {...stylex.props([focus.ring, styles.buttonFlexXs2])}
                              onClick={() => {
                                onDeleteTag(tag.id);
                                setOpenTagMenuId(null);
                              }}
                            >
                              <Trash2 {...stylex.props(styles.deleteTrash2)} aria-hidden="true" />
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
          {selectedTagFilter ? (
            <div {...stylex.props(styles.showing)}>
              Showing {visibleDocumentCount} of {documentCount}
            </div>
          ) : null}
        </section>
      </div>
    </aside>
  );
}

function ScenarioTagColorPicker({
  selectedColor,
  onSelectColor,
  label,
}: {
  selectedColor: string;
  onSelectColor: (color: string) => void;
  label: string;
}) {
  const activeColor = (selectedColor ?? DEFAULT_SCENARIO_TAG_COLOR).toLowerCase();
  return (
    <div {...stylex.props(styles.group)} role="group" aria-label={label}>
      {DEFAULT_SCENARIO_TAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={cn(
            "size-4 border transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
            activeColor === color ? "border-foreground" : "border-border",
          )}
          style={{ backgroundColor: color }}
          aria-label={`Use tag color ${color}`}
          aria-pressed={activeColor === color}
          onClick={() => onSelectColor(color)}
        />
      ))}
    </div>
  );
}

/**
 * Arm an HTML5 drag with a snapshot of the chip as its drag image.
 *
 * The default drag image for a styled `div` is unreliable across browsers, and the chip's colour is
 * the only thing identifying which tag is in flight.
 */
function startTagDrag(
  event: DragEvent<HTMLDivElement>,
  tag: ScenarioTagDto,
  onBeginTagDrag: (tagId: string) => void,
) {
  onBeginTagDrag(tag.id);
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(SCENARIO_TAG_DRAG_MIME, tag.id);
  event.dataTransfer.setData("text/plain", tag.label);

  const source = event.currentTarget;
  const dragImage = source.cloneNode(true) as HTMLElement;
  const rect = source.getBoundingClientRect();
  dragImage.style.position = "fixed";
  dragImage.style.top = "-1000px";
  dragImage.style.left = "-1000px";
  dragImage.style.width = `${rect.width}px`;
  dragImage.style.pointerEvents = "none";
  document.body.appendChild(dragImage);
  event.dataTransfer.setDragImage(dragImage, rect.width / 2, rect.height / 2);
  window.setTimeout(() => dragImage.remove(), 0);
}
