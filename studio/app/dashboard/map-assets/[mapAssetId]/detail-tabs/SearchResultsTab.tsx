"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./SearchResultsTab.stylex";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Bike,
  Bug,
  Bus,
  Check,
  ChevronRight,
  Cross,
  Footprints,
  Fuel,
  Gauge,
  GitFork,
  Hotel,
  Loader2,
  Map,
  MapPin,
  MoreHorizontal,
  Mountain,
  PersonStanding,
  Plane,
  Play,
  Route,
  School,
  ShoppingBag,
  SquareParking,
  Store,
  Target,
  Train,
  UtensilsCrossed,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@simforge-oss/studio-ui/components/ui/tooltip";
import type { MapSearchResult, SearchFilterChip, SearchObjectFamily } from "@/app/lib/maps/search/map-search";
import { SearchExamplesPanel } from "./SearchExamplesPanel";
import { CopyJsonButton } from "./CopyJsonButton";
import { SearchInputBox } from "./SearchInputBox";
import { motionRecipe, textLayout } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

interface SearchResultsTabProps {
  draftQuery: string;
  query: string;
  chips: SearchFilterChip[];
  results: MapSearchResult[];
  /** Leftover tokens after family / semantic aliases consume their matches — surfaced in the debug panel. */
  freeText?: string[];
  selectedResultId: string | null;
  /**
   * Object id of the related ref or topology path step the user has pinned
   * for emphasized rendering on the map. Only one target is highlighted at
   * a time and it's scoped to `selectedResultId` — picking a new result
   * clears it. `null` means "no pinned target", which is the default.
   */
  highlightedRelatedObjectId?: string | null;
  /** True while the underlying corpus (candidates + road network + enrichment) is still loading. */
  loading?: boolean;
  onDraftQueryChange: (value: string) => void;
  onSubmitSearch: (nextQuery?: string) => void;
  onSelectResult: (id: string) => void;
  onZoomToResult: (id: string) => void;
  onUseInScenario: (id: string) => void;
  /** Fired when a result card is hovered (id) or unhovered (null). */
  onHoverResult?: (id: string | null) => void;
  /**
   * Toggle the on-map highlight for a related-ref or path-step. The first
   * arg is the parent result so the parent can promote it to selected when
   * the user picks a target on a card that wasn't already focused. Pass
   * `null` for `objectId` to clear (used by the toggle-off path).
   */
  onToggleHighlightRelated?: (resultId: string, objectId: string | null) => void;
  /** When true, the search input auto-focuses on mount. */
  autoFocus?: boolean;
}

export function formatFamilyLabel(family: SearchObjectFamily): string {
  switch (family) {
    case "junction":
      return "Junction";
    case "street":
      return "Street";
    case "poi":
      return "Point Of Interest";
    case "address":
      return "Address";
    default:
      return family;
  }
}

export function formatRelation(
  op:
    | "near"
    | "adjacent_to"
    | "within"
    | "leads_to"
    | "connected_to"
    | "upstream_of"
    | "downstream_of",
): string {
  switch (op) {
    case "near":
      return "Near";
    case "adjacent_to":
      return "Adjacent to";
    case "within":
      return "Within";
    case "leads_to":
      return "Leading to";
    case "connected_to":
      return "Connected to";
    case "upstream_of":
      return "Before";
    case "downstream_of":
      return "After";
    default:
      return op;
  }
}

/**
 * Compact debug rendering of a MapSearchDocumentGeometryRef so the debug row
 * can show *why* a result lands where it does on the map — the arrow
 * endpoint is a function of the ref's kind and the ids it carries.
 */
function formatGeometryRef(
  ref: MapSearchResult["geometryReference"] | undefined,
): string {
  if (!ref) return "none";
  switch (ref.kind) {
    case "candidate":
      return `candidate[${ref.candidateId ?? "?"}]`;
    case "geojson_feature":
      return `geojson_feature[${ref.geojsonFeatureId ?? "?"}]`;
    case "road_aggregate":
      return `road_aggregate[${ref.geojsonFeatureIds?.length ?? 0}]`;
    case "overlay_feature":
      return `overlay[${ref.overlayLayerId ?? "?"}:${ref.overlayFeatureId ?? "?"}]`;
    default:
      return ref.kind;
  }
}

function formatCentroid(centroid: [number, number] | undefined): string {
  if (!centroid) return "[?,?]";
  return `[${centroid[0].toFixed(5)}, ${centroid[1].toFixed(5)}]`;
}

export function iconForSubtype(subtype: string): LucideIcon {
  switch (subtype) {
    case "Road junction":
      return GitFork;
    case "Street segment":
      return Route;
    case "Steep road":
      return Mountain;
    case "Bike corridor":
    case "Shared bike corridor":
    case "Bike merge corridor":
    case "Protected bike corridor":
      return Bike;
    case "High-speed road":
      return Gauge;
    case "Pedestrian corridor":
      return PersonStanding;
    case "Crosswalk zone":
      return Footprints;
    case "Parking area":
      return SquareParking;
    case "Parking lot":
      return SquareParking;
    case "Bus stop":
      return Bus;
    case "School frontage":
      return School;
    case "Hospital approach":
      return Cross;
    case "Gas station approach":
      return Fuel;
    case "Retail frontage":
      return Store;
    case "Restaurant frontage":
      return UtensilsCrossed;
    case "Hotel approach":
      return Hotel;
    case "Airport approach":
      return Plane;
    case "Shopping mall approach":
      return ShoppingBag;
    case "Transit stop corridor":
      return Train;
    default:
      return MapPin;
  }
}

/**
 * Maps a sidecar object `kind` (junction/street/poi-subtype) to an icon for
 * the topology-path chain. We can't reuse `iconForSubtype` because the path
 * carries `kind` (lowercased, machine-readable), not the user-facing subtype
 * label, and we want the chain to render even for streets/junctions that
 * don't have a subtype mapping.
 */
function iconForPathKind(kind: string | undefined): LucideIcon {
  if (!kind) return MapPin;
  switch (kind) {
    case "junction":
      return GitFork;
    case "street":
    case "street_segment":
      return Route;
    case "bus_stop":
      return Bus;
    case "crosswalk_zone":
      return Footprints;
    case "parking_lot":
    case "parking_area":
      return SquareParking;
    case "school_frontage":
      return School;
    case "hospital_approach":
      return Cross;
    case "gas_station_approach":
      return Fuel;
    case "retail_frontage":
      return Store;
    case "restaurant_frontage":
      return UtensilsCrossed;
    case "hotel_approach":
      return Hotel;
    case "airport_approach":
      return Plane;
    case "shopping_mall_approach":
      return ShoppingBag;
    case "transit_stop_corridor":
      return Train;
    default:
      return MapPin;
  }
}

const TOPOLOGY_RELATIONS = new Set([
  "leads_to",
  "connected_to",
  "upstream_of",
  "downstream_of",
]);

interface TopologyPathChainProps {
  path: NonNullable<MapSearchResult["relatedObjectRefs"]>[number]["path"];
  truncated: boolean;
  /**
   * Object id currently pinned for on-map emphasis. When a path step's id
   * matches, its pill renders in the active style and the toggle button
   * shows the "remove highlight" affordance.
   */
  highlightedObjectId?: string | null;
  /** Toggle handler — pass `null` to clear, an objectId to set. Receives the path-step id. */
  onToggleHighlight?: (objectId: string | null) => void;
}

/**
 * Debug-mode rendering of the topology relation's reconstructed graph
 * route. Outside debug, the chain is hidden entirely — the on-map line
 * plus arrow markers tell the visual story. In debug we keep the chain so
 * each step's canonical object id is inspectable, plus a target button on
 * each step that spotlights it on the map (subject→step landing ring).
 *
 * The first pill is the subject (already named above as the result card)
 * but we keep it in the chain so the eye has a starting anchor. When the
 * executor truncated the path, we drop a `…` between the head and tail
 * slices so the gap is visible rather than silent.
 */
function TopologyPathChain({
  path,
  truncated,
  highlightedObjectId,
  onToggleHighlight,
}: TopologyPathChainProps) {
  if (!path || path.length === 0) return null;
  // Truncation in the executor keeps `floor(MAX/2)` head + `MAX - floor(MAX/2)`
  // tail nodes; the gap sits right after the head. We don't import the
  // constant to avoid coupling the UI to server-side numbers — the path
  // itself plus the `truncated` flag is enough to render it correctly.
  const headEnd = Math.floor(path.length / 2);
  return (
    <div {...stylex.props(styles.pathChain)}>
      <span {...stylex.props(styles.pathLabel)}>
        Path
      </span>
      {path.map((step, idx) => {
        const StepIcon = iconForPathKind(step.kind);
        const isLast = idx === path.length - 1;
        const showEllipsisBefore = truncated && idx === headEnd;
        const stepHighlighted =
          !!highlightedObjectId && highlightedObjectId === step.objectId;
        return (
          <div
            key={`${step.objectId}-${idx}`}
            {...stylex.props(styles.pathStepWrapper)}
          >
            {showEllipsisBefore ? (
              <>
                <MoreHorizontal
                  {...stylex.props(styles.pathEllipsisIcon)}
                  aria-label="path truncated"
                />
                <ChevronRight
                  {...stylex.props(styles.pathEllipsisSeparator)}
                  aria-hidden="true"
                />
              </>
            ) : null}
            <div
              {...stylex.props([motionRecipe.colors, styles.stepChip], stepHighlighted ? styles.stepChipOn : styles.stepChipOff)}
              title={`${step.title ?? step.objectId} (${step.cumulativeM} m from subject)`}
            >
              <StepIcon {...stylex.props(styles.pathStepIcon)} aria-hidden="true" />
              <span {...stylex.props([textLayout.truncate, styles.pathStepObjectId])}>
                {step.objectId}
              </span>
              <span {...stylex.props(styles.pathStepDistance)}>
                {step.cumulativeM}m
              </span>
              {onToggleHighlight ? (
                <HighlightToggleButton
                  active={stepHighlighted}
                  size="xs"
                  label={
                    stepHighlighted
                      ? `Stop highlighting ${step.objectId} on the map`
                      : `Highlight ${step.objectId} on the map`
                  }
                  onClick={() =>
                    onToggleHighlight(stepHighlighted ? null : step.objectId)
                  }
                />
              ) : null}
            </div>
            {!isLast ? (
              <ChevronRight
                {...stylex.props(styles.pathStepSeparator)}
                aria-hidden="true"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface HighlightToggleButtonProps {
  active: boolean;
  label: string;
  onClick: () => void;
  /** `xs` is for the path-chain pills which run at text-[10px]; default for the larger related-ref pill. */
  size?: "default" | "xs";
}

/**
 * Small icon button on a related-ref or path-step pill that toggles whether
 * that target is the on-map highlight. Stops click propagation so clicking
 * the icon doesn't also fire the parent card's "select this result" handler
 * — only the highlight changes (the parent will promote the result to
 * selected if needed via its `onToggleHighlightRelated` handler).
 */
export function HighlightToggleButton({
  active,
  label,
  onClick,
  size = "default",
}: HighlightToggleButtonProps) {
  const dimensions = size === "xs" ? styles.highlightToggleXs : styles.highlightToggleDefault;
  const iconSize = size === "xs" ? styles.highlightIconXs : styles.highlightIconDefault;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-pressed={active}
      aria-label={label}
      title={label}
      {...stylex.props([motionRecipe.colors, styles.highlightToggle], dimensions, active ? styles.highlightToggleOn : styles.highlightToggleOff)}
    >
      <Target {...stylex.props(iconSize)} aria-hidden="true" />
    </button>
  );
}

export function SearchResultsTab({
  draftQuery,
  query,
  chips,
  results,
  freeText = [],
  selectedResultId,
  highlightedRelatedObjectId = null,
  loading = false,
  onDraftQueryChange,
  onSubmitSearch,
  onSelectResult,
  onZoomToResult,
  onUseInScenario,
  onHoverResult,
  onToggleHighlightRelated,
  autoFocus = false,
}: SearchResultsTabProps) {
  const [showDebug, setShowDebug] = useState(false);

  // When a multi-facet query returns zero results, offer each facet as a
  // standalone sub-query the user can click to re-run. Helps the user
  // discover that their map has e.g. medium parking lots even though there
  // are no "large" ones matching "large parking lot".
  const alternativeQueries = useMemo(() => {
    if (!query.trim() || loading || results.length > 0) return [];
    const total = chips.length + freeText.length;
    if (total <= 1) return [];
    const alts: string[] = [];
    for (const chip of chips) alts.push(chip.label);
    for (const token of freeText) {
      alts.push(token.includes(" ") ? `"${token}"` : token);
    }
    const seen = new Set<string>();
    return alts.filter((alt) => {
      const key = alt.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [chips, freeText, query, loading, results.length]);

  if (!query.trim()) {
    return (
      <div {...stylex.props(styles.emptyQueryState)}>
        <div {...stylex.props(styles.emptyQueryInputPanel)}>
          <SearchInputBox
            draftQuery={draftQuery}
            onDraftQueryChange={onDraftQueryChange}
            onSubmitSearch={onSubmitSearch}
            autoFocus={autoFocus}
          />

          <div {...stylex.props(styles.queryPrompt)}>
            <p {...stylex.props(styles.queryPromptHeading)}>Try a spatial query</p>
            <p {...stylex.props(styles.queryPromptDescription)}>
              Click a chip to run it, or build your own query — every junction,
              street, and feature on the map is indexed.
            </p>
          </div>
        </div>

        <div {...stylex.props(styles.searchExamplesPanel)}>
          <SearchExamplesPanel onRunExample={onSubmitSearch} />
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div {...stylex.props(styles.resultsPage)}>
        <div {...stylex.props(styles.resultsHeader)}>
          <SearchInputBox
            draftQuery={draftQuery}
            onDraftQueryChange={onDraftQueryChange}
            onSubmitSearch={onSubmitSearch}
            autoFocus={autoFocus}
          />
          {showDebug ? (
            <div {...stylex.props(styles.debugPanel)}>
              <p {...stylex.props(styles.debugSectionLabel)}>
                <span {...stylex.props(styles.parsedQueryLabel)}>Parsed query</span>
                {" — "}
                chips: {chips.length}, free-text: {freeText.length}, results: {results.length}
              </p>
              {chips.length > 0 ? (
                <div>
                  <p {...stylex.props(styles.debugSectionLabel)}>Chips</p>
                  <div {...stylex.props(styles.debugTokenList)}>
                    {chips.map((chip) => (
                      <Badge
                        key={`debug-${chip.id}`}
                        variant="outline"
                        xstyle={styles.debugTokenBadge}
                      >
                        {chip.id}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {freeText.length > 0 ? (
                <div>
                  <p {...stylex.props(styles.debugSectionLabel)}>Free-text tokens</p>
                  <div {...stylex.props(styles.debugTokenList)}>
                    {freeText.map((token) => (
                      <Badge
                        key={`ft-${token}`}
                        variant="outline"
                        xstyle={styles.debugTokenBadge}
                      >
                        {token}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {chips.length > 0 || freeText.length > 0 ? (
            <div {...stylex.props(styles.filterChipsRow)}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setShowDebug((prev) => !prev)}
                    aria-label="Toggle search debug"
                    aria-pressed={showDebug}
                    {...stylex.props([motionRecipe.colors, styles.debugToggle], showDebug && styles.debugToggleOn)}
                  >
                    <Bug {...stylex.props(styles.compactContextIcon)} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" xstyle={styles.tooltipContent}>
                  {showDebug ? "Hide debug" : "Show debug"}
                </TooltipContent>
              </Tooltip>
              {chips.map((chip) =>
                chip.kind === "relation" && chip.operatorLabel && chip.objectLabel ? (
                  <span
                    key={chip.id}
                    {...stylex.props(styles.relationChip)}
                    title={`Spatial relation: ${chip.operatorLabel} ${chip.objectLabel}`}
                  >
                    <span {...stylex.props(styles.relationOperator)}>
                      {chip.operatorLabel}
                    </span>
                    <span {...stylex.props(styles.relationObject)}>
                      {chip.objectLabel}
                    </span>
                  </span>
                ) : (
                  <Badge
                    key={chip.id}
                    variant="secondary"
                    xstyle={styles.structuredFilterBadge}
                  >
                    {chip.label}
                  </Badge>
                ),
              )}
              {freeText.map((token) => (
                <Badge
                  key={`free-${token}`}
                  variant="outline"
                  xstyle={styles.freeTextBadge}
                  title="Free-text token — not matched to a structured filter"
                >
                  {token}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div {...stylex.props(styles.resultsContent)}>
          {loading ? (
            <p {...stylex.props(styles.loadingStatus)}>
              <Loader2 {...stylex.props([motionRecipe.spin, styles.loadingIcon])} aria-hidden="true" /> Loading map data…
            </p>
          ) : (
            <div {...stylex.props(styles.resultsHeaderActions)}>
              <span>Results ({results.length})</span>
              <CopyJsonButton
                payload={{ query, chips, freeText: freeText ?? [], results }}
                disabled={results.length === 0}
                label="Copy results as JSON"
              />
            </div>
          )}
          <div {...stylex.props(styles.resultList)}>
            <div {...stylex.props(styles.resultCardsContainer)}>
              {results.map((result) => {
                const selected = result.id === selectedResultId;
                const ResultIcon = iconForSubtype(result.subtype);
                return (
                  <div
                    key={result.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    onClick={() => onSelectResult(result.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectResult(result.id);
                      }
                    }}
                    onMouseEnter={() => onHoverResult?.(result.id)}
                    onMouseLeave={() => onHoverResult?.(null)}
                    onFocus={() => onHoverResult?.(result.id)}
                    onBlur={() => onHoverResult?.(null)}
                    {...stylex.props(styles.resultCard, selected ? styles.resultCardSelected : styles.resultCardIdle)}
                  >
                    <div {...stylex.props(styles.resultCardHeader)}>
                      <ResultIcon
                        {...stylex.props(styles.resultTypeIcon)}
                        aria-label={`${result.subtype} icon`}
                      />
                      <p {...stylex.props([textLayout.truncate, styles.resultTitle])}>
                        {result.title}
                      </p>
                      {selected ? <Check {...stylex.props(styles.selectedCheckIcon)} /> : null}
                    </div>

                    <div {...stylex.props(styles.resultMetadataGrid)}>
                      <div {...stylex.props(styles.metadataItem)}>
                        <p {...stylex.props([textLayout.truncate, styles.metadataLabel])}>Type</p>
                        <p {...stylex.props([textLayout.truncate, styles.metadataValue])}>
                          {formatFamilyLabel(result.objectFamily)}
                        </p>
                      </div>
                      <div {...stylex.props(styles.metadataItem)}>
                        <p {...stylex.props([textLayout.truncate, styles.metadataLabel])}>SubType</p>
                        <p {...stylex.props([textLayout.truncate, styles.metadataValue])}>{result.subtype}</p>
                      </div>
                      <div {...stylex.props(styles.metadataItem)}>
                        <p {...stylex.props([textLayout.truncate, styles.metadataLabel])}>Confidence</p>
                        <p {...stylex.props([textLayout.truncate, styles.confidenceValue])}>
                          {Math.round(result.candidateConfidence * 100)}%
                        </p>
                      </div>
                    </div>

                    {result.exactMapAttributes.length > 0 ? (
                      <div {...stylex.props(styles.attributeBadgeRow)}>
                        {result.exactMapAttributes.map((fact) => (
                          <Badge
                            key={fact}
                            variant="secondary"
                            xstyle={styles.attributeBadge}
                          >
                            {fact}
                          </Badge>
                        ))}
                      </div>
                    ) : null}

                    {result.relatedObjectRefs && result.relatedObjectRefs.length > 0 ? (
                      <div {...stylex.props(styles.relatedRefsList)}>
                        {result.relatedObjectRefs.slice(0, 2).map((ref) => {
                          const RefIcon = ref.subtype ? iconForSubtype(ref.subtype) : MapPin;
                          const refHighlighted =
                            highlightedRelatedObjectId === ref.objectId;
                          return (
                            <div
                              key={`${result.id}-rel-${ref.objectId}`}
                              {...stylex.props(styles.relatedRefItem)}
                            >
                              <div
                                {...stylex.props(styles.refChip, refHighlighted ? styles.refChipOn : styles.refChipOff)}
                                title={`${formatRelation(ref.relation)} ${ref.title ?? ref.objectId}${ref.distance_m != null ? ` (${ref.distance_m} m)` : ""}`}
                              >
                                <span {...stylex.props(styles.relationLabelRow)}>
                                  <ArrowRight {...stylex.props(styles.compactContextIcon)} aria-hidden="true" />
                                  <span {...stylex.props(styles.relationText)}>{formatRelation(ref.relation)}</span>
                                </span>
                                <RefIcon
                                  {...stylex.props(styles.relatedRefIcon)}
                                  aria-hidden="true"
                                />
                                <span {...stylex.props([textLayout.truncate, styles.relatedRefTitle])}>
                                  {ref.title ?? ref.objectId}
                                </span>
                                {ref.distance_m != null ? (
                                  <span {...stylex.props(styles.relatedRefDistance)}>
                                    {ref.distance_m} m
                                  </span>
                                ) : null}
                                {onToggleHighlightRelated ? (
                                  <HighlightToggleButton
                                    active={refHighlighted}
                                    label={
                                      refHighlighted
                                        ? `Stop highlighting ${ref.title ?? ref.objectId} on the map`
                                        : `Highlight ${ref.title ?? ref.objectId} on the map`
                                    }
                                    onClick={() =>
                                      onToggleHighlightRelated(
                                        result.id,
                                        refHighlighted ? null : ref.objectId,
                                      )
                                    }
                                  />
                                ) : null}
                              </div>
                              {showDebug &&
                              TOPOLOGY_RELATIONS.has(ref.relation) &&
                              ref.path &&
                              ref.path.length > 2 ? (
                                <TopologyPathChain
                                  path={ref.path}
                                  truncated={ref.pathTruncated === true}
                                  highlightedObjectId={highlightedRelatedObjectId}
                                  onToggleHighlight={
                                    onToggleHighlightRelated
                                      ? (objectId) =>
                                          onToggleHighlightRelated(result.id, objectId)
                                      : undefined
                                  }
                                />
                              ) : null}
                              {showDebug ? (
                                <div {...stylex.props(styles.relatedRefDebugMetadata)}>
                                  <span {...stylex.props(styles.debugValue)}>{ref.objectId}</span>
                                  <span>·</span>
                                  <span {...stylex.props(styles.debugValue)}>
                                    {formatGeometryRef(ref.geometryReference)}
                                  </span>
                                  <span>·</span>
                                  <span {...stylex.props(styles.debugValue)}>{formatCentroid(ref.centroid)}</span>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {showDebug ? (
                      <div {...stylex.props(styles.resultDebugPanel)}>
                        <div {...stylex.props(styles.resultDebugIdentity)}>
                          <span {...stylex.props(styles.debugValue)}>{result.id}</span>
                          <span>·</span>
                          <span {...stylex.props(styles.debugValue)}>
                            {formatGeometryRef(result.geometryReference)}
                          </span>
                          <span>·</span>
                          <span {...stylex.props(styles.debugValue)}>{formatCentroid(result.centroid)}</span>
                        </div>
                        {result.matchReasons.length > 0 ? (
                          <div {...stylex.props(textLayout.truncate)}>
                            match: {result.matchReasons.slice(0, 3).join(", ")}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div {...stylex.props(styles.resultActions)}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            xstyle={styles.resultActionButton}
                            onClick={(event) => {
                              event.stopPropagation();
                              onZoomToResult(result.id);
                            }}
                            aria-label="Zoom on Map"
                          >
                            <Map {...stylex.props(styles.resultActionIcon)} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" xstyle={styles.tooltipContent}>
                          Zoom on Map
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            xstyle={styles.resultActionButton}
                            onClick={(event) => {
                              event.stopPropagation();
                              onUseInScenario(result.id);
                            }}
                            aria-label="Use in Scenario"
                          >
                            <Play {...stylex.props(styles.resultActionIcon)} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" xstyle={styles.tooltipContent}>
                          Use in Scenario
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
              {results.length === 0 ? (
                <div {...stylex.props(styles.emptyResultsState)}>
                  {loading ? (
                    <p {...stylex.props(styles.emptyResultsLoading)}>
                      <Loader2 {...stylex.props([motionRecipe.spin, styles.loadingIcon])} aria-hidden="true" /> Loading map data…
                    </p>
                  ) : (
                    <>
                      <p {...stylex.props(styles.noResultsHeading)}>No matching locations</p>
                      <p {...stylex.props(styles.noResultsGuidance)}>
                        Try broadening the query or removing a few constraints.
                      </p>
                      {alternativeQueries.length > 0 ? (
                        <div {...stylex.props(styles.alternativeQueriesSection)}>
                          <p {...stylex.props(styles.alternativeQueriesHeading)}>Or try each term on its own:</p>
                          <div {...stylex.props(styles.alternativeQueriesList)}>
                            {alternativeQueries.map((alt) => (
                              <button
                                key={alt}
                                type="button"
                                onClick={() => {
                                  onDraftQueryChange(alt);
                                  onSubmitSearch(alt);
                                }}
                                {...stylex.props([motionRecipe.colors, styles.alternativeQueryButton])}
                              >
                                {alt}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
