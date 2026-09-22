"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioDocumentRow.stylex";
import { useState } from "react";
import type { MutableRefObject } from "react";
import {
  CopyPlus,
  Download,
  Gamepad2,
  GitBranch,
  MapPinned,
  MoreHorizontal,
  Pencil,
  Trash2,
  Video,
} from "lucide-react";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import type {
  ScenarioDocumentSummaryDto,
  ScenarioRatingAggregateDto,
  ScenarioTagDto,
} from "../../lib/scenario/contracts";
import { Button } from "../../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { cn } from "../../lib/utils";
import { control, menu, renderInk, row } from "../scenario-controls.stylex";
import { documentCardTransitionName } from "./datasetMorph";
import {
  documentEditedAtLabel,
  documentLastEditorName,
  documentMapLabel,
  documentName,
} from "./document-list-utils";
import { ScenarioRating } from "./ScenarioRating";
import { useScenarioOpenScenarioExport } from "./useScenarioOpenScenarioExport";
import { useStudioHost } from "../../host";
import { useStudioHostCapabilities } from "@simforge-oss/studio-host/react";
import { textLayout } from "../../stylex/recipes.stylex";

export const SCENARIO_TAG_DRAG_MIME = "application/x-simforge-scenario-tag-id";

/**
 * Whether the row shows its variations (fork) toggle.
 *
 * A named constant rather than deleted markup: the decision to drop cross-map variations is a product
 * call that could be revisited, and a flag records that this was switched off deliberately instead of
 * leaving a future reader to wonder whether the button was ever wired.
 */
const SHOW_VARIATIONS_TOGGLE = false;

type RenderState = "missing" | "complete" | "running";

function renderIconStyle(state: RenderState, active: boolean, disabled: boolean) {
  // Traffic-light semantics, and deliberately not tokens: `primary` is the brand yellow, so a
  // running render would be indistinguishable from every other accent in the row.
  // A disabled button took Tailwind's `hover:text-current`, which is the resting colour: here
  // that is the variant of each pair that declares no hover at all.
  if (active) return disabled ? renderInk.activeFlat : renderInk.active;
  if (state === "running") return disabled ? renderInk.runningFlat : renderInk.running;
  if (state === "complete") return disabled ? renderInk.completeFlat : renderInk.complete;
  return disabled ? renderInk.noneFlat : renderInk.none;
}

function renderIconTitle(
  state: RenderState,
  hasSensorProfile: boolean,
) {
  if (!hasSensorProfile) return "Add a sensor profile to an actor before rendering";
  if (state === "running") return "Render running";
  if (state === "complete") return "Rendered";
  return "No render";
}

/**
 * An operator-chosen tag colour as a chip style.
 *
 * Inline rather than a class because the value is data. `color-mix` keeps the border and fill derived
 * from the one colour, so a tag stays one visual object at any hue — v1 hand-rolled the same thing
 * with a hex→rgba helper.
 */
function tagChipStyle(color: string | null) {
  const base = color ?? "var(--accent-brand)";
  return {
    borderColor: `color-mix(in srgb, ${base} 38%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${base} 10%, transparent)`,
    color: base,
  };
}

export type ScenarioDocumentRowProps = {
  document: ScenarioDocumentSummaryDto;
  datasetId: string;
  active: boolean;
  advancedMode: boolean;
  tagEditorMode: boolean;
  mutable: boolean;
  busy: boolean;
  renaming: boolean;
  renameDraft: string;
  renderActive?: boolean;
  /**
   * Another scenario owns the render pane. Recedes this row so the one being rendered reads as the
   * subject of the pane beside it.
   */
  renderDimmed?: boolean;
  renderInProgress: boolean;
  /** Variation sub-rows are the same scenario on another map, so they are titled by map. */
  labelByMap?: boolean;
  variationCount?: number;
  variationsExpanded?: boolean;
  availableTags: ScenarioTagDto[];
  ratingAggregate?: ScenarioRatingAggregateDto;
  ratingLoading?: boolean;
  ratingSaving?: boolean;
  ratingError?: string | null;
  draggingTagId: string | null;
  draggingTagIdRef: MutableRefObject<string | null>;
  onClearDraggingTag: () => void;
  onAssignTag: (documentId: string, tagId: string) => void;
  onRenameDraftChange: (next: string) => void;
  onSetRenamingDocumentId: (id: string | null) => void;
  onCommitRename: (document: ScenarioDocumentSummaryDto, draft: string) => void;
  onOpenDocument: (document: ScenarioDocumentSummaryDto) => void;
  onEditDocument: (document: ScenarioDocumentSummaryDto) => void;
  /**
   * Whether this document is the one currently open in the editor.
   *
   * Mirrors v1's row: the pencil is a toggle, not a one-way trip. Without it the button gives no sign
   * that this row is the open one, and there is no way back to the list from the row that opened it.
   */
  editActive?: boolean;
  /** Close the editor and return to the list. Required for the toggle half of `editActive`. */
  onExitEdit?: () => void;
  onRenderDocument: (document: ScenarioDocumentSummaryDto) => void;
  /**
   * Create a Driver in the Loop variation of this scenario and drive it.
   *
   * Optional because the review queue renders the same row without the drive
   * affordance; the button is absent rather than inert when it is not supplied.
   */
  onDriverInTheLoop?: (document: ScenarioDocumentSummaryDto) => void;
  onDownloadDocument: (document: ScenarioDocumentSummaryDto) => void;
  onDuplicateDocument: (document: ScenarioDocumentSummaryDto) => void;
  onTransferDocument?: (document: ScenarioDocumentSummaryDto) => void;
  onEditDetails: (document: ScenarioDocumentSummaryDto) => void;
  onDeleteDocument: (document: ScenarioDocumentSummaryDto) => void;
  onSetRating: (rating: number) => void;
  onToggleVariations?: (document: ScenarioDocumentSummaryDto) => void;
  onError: (error: unknown, fallback: string) => void;
  onNotice?: (message: string | null) => void;
};

function DocumentActionCluster({
  document,
  datasetId: _datasetId,
  mutable,
  busy,
  renaming,
  renameDraft,
  editActive = false,
  renderActive = false,
  renderInProgress,
  variationCount = 0,
  variationsExpanded = false,
  onRenameDraftChange,
  onSetRenamingDocumentId,
  onCommitRename,
  onEditDocument,
  onExitEdit,
  onRenderDocument,
  onDriverInTheLoop,
  onDownloadDocument,
  onDuplicateDocument,
  onTransferDocument,
  onEditDetails,
  onDeleteDocument,
  onToggleVariations,
  onError,
  onNotice,
}: Pick<
  ScenarioDocumentRowProps,
  | "document"
  | "datasetId"
  | "mutable"
  | "busy"
  | "renaming"
  | "renameDraft"
  | "editActive"
  | "renderActive"
  | "renderInProgress"
  | "variationCount"
  | "variationsExpanded"
  | "onRenameDraftChange"
  | "onSetRenamingDocumentId"
  | "onCommitRename"
  | "onEditDocument"
  | "onExitEdit"
  | "onRenderDocument"
  | "onDriverInTheLoop"
  | "onDownloadDocument"
  | "onDuplicateDocument"
  | "onTransferDocument"
  | "onEditDetails"
  | "onDeleteDocument"
  | "onToggleVariations"
  | "onError"
  | "onNotice"
> ) {
  const hostCapabilities = useStudioHostCapabilities(useStudioHost());
  const actionCapability = (
    action: "transfer" | "driver-in-the-loop",
  ) => hostCapabilities.capabilities?.actions?.[action];
  const transferCapability = actionCapability("transfer");
  const driverCapability = actionCapability("driver-in-the-loop");
  const label = documentName(document);
  const openScenarioExport = useScenarioOpenScenarioExport({
    documentId: document.id,
    onError,
    onNotice,
  });
  const renderState: RenderState = renderInProgress
    ? "running"
    : document.hasRender
      ? "complete"
      : "missing";
  const anyBusy = busy || openScenarioExport.busy;
  const renderDisabled = !document.hasSensorProfile;

  return (
    <div {...stylex.props(styles.divFlex)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            xstyle={[control.iconSm, row.quiet]}
            disabled={anyBusy}
            aria-label={`Scenario actions for ${label}`}
          >
            {anyBusy ? (
              <CloudActivityIndicator />
            ) : (
              <MoreHorizontal {...stylex.props(styles.morehorizontalIcon)} aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" xstyle={menu.width160}>
          <DropdownMenuItem onSelect={() => onDownloadDocument(document)}>
            <Download {...stylex.props(styles.downloadJSONDownload)} aria-hidden="true" />
            Download JSON
          </DropdownMenuItem>
          {openScenarioExport.menuItem}
          <DropdownMenuItem disabled={!mutable} onSelect={() => onEditDetails(document)}>
            <Pencil {...stylex.props(styles.editDetailsPencil)} aria-hidden="true" />
            Edit details
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onDuplicateDocument(document)}>
            <CopyPlus {...stylex.props(styles.duplicateCopyPlus)} aria-hidden="true" />
            Duplicate
          </DropdownMenuItem>
          {onTransferDocument && transferCapability?.available !== false ? (
            <DropdownMenuItem disabled={!mutable} onSelect={() => onTransferDocument(document)}>
              <MapPinned {...stylex.props(styles.transferMapPin)} aria-hidden="true" />
              Transfer to another map
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            xstyle={menu.destructiveItem}
            disabled={!mutable}
            onSelect={() => onDeleteDocument(document)}
          >
            <Trash2 {...stylex.props(styles.deleteTrash2)} aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming ? (
        <input
          autoFocus
          type="text"
          aria-label={`Rename ${label}`}
          value={renameDraft}
          onChange={(event) => onRenameDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const draft = renameDraft;
              onSetRenamingDocumentId(null);
              onCommitRename(document, draft);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onSetRenamingDocumentId(null);
            }
          }}
          onBlur={() => {
            const draft = renameDraft;
            onSetRenamingDocumentId(null);
            onCommitRename(document, draft);
          }}
          {...stylex.props(styles.renameInput)}
        />
      ) : null}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        xstyle={[
          control.iconSm,
          control.flatBackground,
          editActive ? row.activeInk : row.quiet,
        ]}
        aria-label={editActive ? `Exit editor for ${label}` : `Edit ${label}`}
        aria-pressed={editActive}
        title={editActive ? "Exit editor" : "Edit"}
        onClick={() => {
          // Only a toggle when a way back was supplied; otherwise pressing it again would appear to do
          // nothing at all.
          if (editActive && onExitEdit) {
            onExitEdit();
            return;
          }
          onEditDocument(document);
        }}
      >
        <Pencil {...stylex.props(styles.pencilIcon)} aria-hidden="true" />
      </Button>
      {onDriverInTheLoop && driverCapability?.available !== false ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                xstyle={[
                  control.iconSm,
                  control.flatBackground,
                  mutable ? row.quiet : row.disabled,
                ]}
                aria-label={`Create a Driver in the Loop variation of ${label}`}
                aria-disabled={!mutable || undefined}
                data-scenario-driver-in-the-loop=""
                onClick={() => {
                  if (!mutable || anyBusy) return;
                  onDriverInTheLoop(document);
                }}
              >
                {anyBusy ? (
                  <CloudActivityIndicator />
                ) : (
                  <Gamepad2 {...stylex.props(styles.gamepadIcon)} aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {mutable
                ? "Driver in the Loop: drive this scenario's car yourself and keep the drive as a variation"
                : "This dataset is read-only"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {/* The fork/variations affordance is hidden by decision (2026-08-04): cross-map variations is
          dropped along with the archive export-package and the old play preview, and preview is being
          rebuilt on the ported studio playback runtime. The props stay on the contract rather than being
          ripped out, so `variationCount` still drives the grouped rows in the list body — only the row's
          own toggle is gone. */}
      {SHOW_VARIATIONS_TOGGLE && variationCount > 0 && onToggleVariations ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          xstyle={[
            control.relative,
            control.iconSm,
            control.flatBackground,
            variationsExpanded ? row.accentInk : null,
          ]}
          aria-label={`${variationsExpanded ? "Hide" : "Show"} ${variationCount} variation${
            variationCount === 1 ? "" : "s"
          } of ${label}`}
          aria-expanded={variationsExpanded}
          title={`${variationCount} variation${variationCount === 1 ? "" : "s"}`}
          data-scenario-variations-toggle=""
          onClick={() => onToggleVariations(document)}
        >
          <GitBranch {...stylex.props(styles.gitbranchIcon)} aria-hidden="true" />
          <span {...stylex.props(styles.spanAbsoluteFlexMeta)}>
            {variationCount}
          </span>
        </Button>
      ) : null}
      {/*
        `aria-disabled` rather than `disabled`, so the reason is reachable.

        A `disabled` button receives no pointer events, which means neither a
        Radix tooltip nor the native `title` fires on hover — the control simply
        did nothing and said nothing about why. Keeping it enabled to the
        browser and inert in the handler lets the tooltip explain itself, while
        `aria-disabled` still announces the state to assistive tech.
      */}
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              xstyle={[
                control.iconSm,
                control.flatBackground,
                renderIconStyle(renderState, renderActive, renderDisabled),
                renderDisabled ? row.disabled : null,
              ]}
              aria-label={`Render ${label}`}
              aria-pressed={renderActive}
              aria-disabled={renderDisabled || undefined}
              data-render-state={renderState}
              data-render-active={renderActive ? "true" : undefined}
              data-render-disabled-reason={renderDisabled ? "no-sensor-profile" : undefined}
              onClick={() => {
                if (renderDisabled) return;
                onRenderDocument(document);
              }}
            >
              <Video {...stylex.props(styles.videoIcon)} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {renderIconTitle(renderState, document.hasSensorProfile)}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

/**
 * One document in the list.
 *
 * Two layouts, as in v1: compact (one line, title and actions) and advanced (a full-width content
 * column plus actions, adding tag pills, the last-editor line and the rating widget). Advanced mode
 * is the gate that reveals the review affordances, so the compact row stays a navigation list.
 *
 * The drop target is the whole row and it accepts both a real HTML5 drag and a bare pointer drag —
 * v1 wired both because the tag chips are draggable `div`s and a pointer-down that never crosses the
 * drag threshold still has to land somewhere.
 */
export function ScenarioDocumentRow({
  document,
  datasetId,
  active,
  advancedMode,
  tagEditorMode,
  mutable,
  busy,
  renaming,
  renameDraft,
  editActive = false,
  renderActive = false,
  renderDimmed = false,
  renderInProgress,
  labelByMap = false,
  variationCount = 0,
  variationsExpanded = false,
  ratingAggregate,
  ratingLoading = false,
  ratingSaving = false,
  ratingError = null,
  draggingTagId,
  draggingTagIdRef,
  onClearDraggingTag,
  onAssignTag,
  onRenameDraftChange,
  onSetRenamingDocumentId,
  onCommitRename,
  onOpenDocument,
  onEditDocument,
  onExitEdit,
  onRenderDocument,
  onDriverInTheLoop,
  onDownloadDocument,
  onDuplicateDocument,
  onTransferDocument,
  onEditDetails,
  onDeleteDocument,
  onSetRating,
  onToggleVariations,
  onError,
  onNotice,
}: ScenarioDocumentRowProps) {
  const [tagDropTarget, setTagDropTarget] = useState(false);
  const lastEditorName = documentLastEditorName(document);
  const editedLabel = documentEditedAtLabel(document);
  const label = labelByMap ? documentMapLabel(document) : documentName(document);
  const isVariation =
    document.derivationKind === "variation" || document.derivationKind === "cross_map_variation";

  const clearTagDropTarget = () => setTagDropTarget(false);
  const dropTagFromPointer = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    const tagId = draggingTagIdRef.current ?? draggingTagId;
    if (!tagId) return;
    event.preventDefault();
    event.stopPropagation();
    onAssignTag(document.id, tagId);
    clearTagDropTarget();
    onClearDraggingTag();
  };

  return (
    <div
      data-scenario-document-card=""
      data-document-id={document.id}
      data-scenario-tag-drop-target={tagDropTarget ? "" : undefined}
      style={{ viewTransitionName: documentCardTransitionName(document.id) }}
      onDragEnter={
        tagEditorMode
          ? (event) => {
              if (!event.dataTransfer.types.includes(SCENARIO_TAG_DRAG_MIME)) return;
              event.preventDefault();
              setTagDropTarget(true);
            }
          : undefined
      }
      onDragOver={
        tagEditorMode
          ? (event) => {
              if (!event.dataTransfer.types.includes(SCENARIO_TAG_DRAG_MIME)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setTagDropTarget(true);
            }
          : undefined
      }
      onDragLeave={
        tagEditorMode
          ? (event) => {
              // Moving between the row's own children fires dragleave on the row; only a real exit
              // should clear the highlight.
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              clearTagDropTarget();
            }
          : undefined
      }
      onDrop={
        tagEditorMode
          ? (event) => {
              const tagId = event.dataTransfer.getData(SCENARIO_TAG_DRAG_MIME);
              if (!tagId) return;
              event.preventDefault();
              onAssignTag(document.id, tagId);
              clearTagDropTarget();
            }
          : undefined
      }
      onPointerEnter={
        tagEditorMode
          ? () => {
              if (!draggingTagIdRef.current && !draggingTagId) return;
              setTagDropTarget(true);
            }
          : undefined
      }
      onPointerLeave={tagEditorMode ? () => tagDropTarget && clearTagDropTarget() : undefined}
      onPointerUp={tagEditorMode ? dropTagFromPointer : undefined}
      className={cn(
        "group render-surface-motion border-0 border-b border-white/10 bg-transparent px-2 transition-colors",
        advancedMode
          ? "grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3"
          : "flex min-h-10 items-center gap-2 py-1.5",
        active
          ? "border-l-2 border-l-primary text-foreground"
          : "border-l-2 border-l-transparent hover:border-l-primary/60",
        tagDropTarget
          ? "border-l-primary text-primary"
          : null,
        tagEditorMode && draggingTagId ? "cursor-copy hover:border-l-primary" : null,
        // Receding, not hiding: the author still needs to read the other scenarios to switch to one,
        // and hover restores full strength so the list stays browsable while a render is open.
        renderDimmed ? "opacity-45 hover:opacity-100" : null,
        renderActive ? "bg-primary/[0.07]" : null,
      )}
      data-render-dimmed={renderDimmed ? "true" : undefined}
    >
      <div {...stylex.props(styles.div)}>
        <button
          type="button"
          className={cn(
            "block w-full truncate text-left font-medium text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            advancedMode ? "text-sm" : "text-[13px]",
          )}
          onClick={() => onOpenDocument(document)}
          aria-label={`Open ${label}`}
        >
          {label}
        </button>
        {!advancedMode && isVariation ? (
          <span
            data-scenario-variation-tag=""
            {...stylex.props(styles.variation)}
          >
            Variation
          </span>
        ) : null}
        {!labelByMap ? (
          <div
            {...stylex.props(styles.div2)}
            data-scenario-document-description=""
          >
            {document.description?.trim() || "No description"}
          </div>
        ) : null}
        {advancedMode && (
          tagDropTarget || document.tags.length > 0 || document.contentTags.length > 0
        ) ? (
          <div
            {...stylex.props(styles.tagsFor)}
            aria-label={`Tags for ${label}`}
            data-scenario-tag-pills=""
          >
            {tagDropTarget ? (
              <span
                data-scenario-tag-drop-prompt=""
                {...stylex.props(styles.letGoToApplyTag)}
              >
                Let go to apply tag
              </span>
            ) : null}
            {document.tags.map((tag) => (
              <span
                key={tag.id}
                {...stylex.props(styles.spanMetaUppercase)}
                style={tagChipStyle(tag.color)}
              >
                {tag.label}
              </span>
            ))}
            {/* Content tags are part of the hashed scenario content, so they remain read-only. */}
            {document.contentTags.map((tag) => (
              <span
                key={`content-${tag}`}
                title="Authored in the scenario content — not editable here"
                {...stylex.props(styles.authoredInTheScenarioContent)}
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {advancedMode && (lastEditorName || editedLabel) ? (
          <div {...stylex.props(styles.divFlexMetaMicro)}>
            {lastEditorName ? (
              <div {...stylex.props(textLayout.truncate)} data-scenario-last-edited-by="">
                {`Last edited by: ${lastEditorName}`}
              </div>
            ) : null}
            {editedLabel ? (
              <div {...stylex.props(textLayout.truncate)} data-scenario-edited-at="">
                {`Edited: ${editedLabel}`}
              </div>
            ) : null}
          </div>
        ) : null}
        {advancedMode ? (
          <ScenarioRating
            aggregate={ratingAggregate}
            error={ratingError}
            loading={ratingLoading}
            saving={ratingSaving}
            documentName={label}
            onSetRating={onSetRating}
          />
        ) : null}
      </div>
      <DocumentActionCluster
        document={document}
        datasetId={datasetId}
        mutable={mutable}
        busy={busy}
        renaming={renaming}
        renameDraft={renameDraft}
        editActive={editActive}
        renderActive={renderActive}
        renderInProgress={renderInProgress}
        variationCount={variationCount}
        variationsExpanded={variationsExpanded}
        onRenameDraftChange={onRenameDraftChange}
        onSetRenamingDocumentId={onSetRenamingDocumentId}
        onCommitRename={onCommitRename}
        onEditDocument={onEditDocument}
        onExitEdit={onExitEdit}
        onRenderDocument={onRenderDocument}
        onDriverInTheLoop={onDriverInTheLoop}
        onDownloadDocument={onDownloadDocument}
        onDuplicateDocument={onDuplicateDocument}
        onTransferDocument={onTransferDocument}
        onEditDetails={onEditDetails}
        onDeleteDocument={onDeleteDocument}
        onToggleVariations={onToggleVariations}
        onError={onError}
        onNotice={onNotice}
      />
    </div>
  );
}
