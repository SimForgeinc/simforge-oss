"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../../map-assets.stylex";

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
    <div className={stylex.props(styles.s_868).className}>
      <span className={stylex.props(styles.s_869).className}>
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
            className={stylex.props(styles.s_961).className}
          >
            {showEllipsisBefore ? (
              <>
                <MoreHorizontal
                  className={stylex.props(styles.s_871).className}
                  aria-label="path truncated"
                />
                <ChevronRight
                  className={stylex.props(styles.s_872).className}
                  aria-hidden="true"
                />
              </>
            ) : null}
            <div
              className={stylex.props(styles.stepChip, stepHighlighted ? styles.stepChipOn : styles.stepChipOff).className}
              title={`${step.title ?? step.objectId} (${step.cumulativeM} m from subject)`}
            >
              <StepIcon className={stylex.props(styles.s_873).className} aria-hidden="true" />
              <span className={stylex.props(styles.s_874).className}>
                {step.objectId}
              </span>
              <span className={stylex.props(styles.s_875).className}>
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
                className={stylex.props(styles.s_876).className}
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
      className={stylex.props(styles.highlightToggle, dimensions, active ? styles.highlightToggleOn : styles.highlightToggleOff).className}
    >
      <Target className={stylex.props(iconSize).className} aria-hidden="true" />
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
      <div className={stylex.props(styles.s_877).className}>
        <div className={stylex.props(styles.s_878).className}>
          <SearchInputBox
            draftQuery={draftQuery}
            onDraftQueryChange={onDraftQueryChange}
            onSubmitSearch={onSubmitSearch}
            autoFocus={autoFocus}
          />

          <div className={stylex.props(styles.s_879).className}>
            <p className={stylex.props(styles.s_880).className}>Try a spatial query</p>
            <p className={stylex.props(styles.s_881).className}>
              Click a chip to run it, or build your own query — every junction,
              street, and feature on the map is indexed.
            </p>
          </div>
        </div>

        <div className={stylex.props(styles.s_882).className}>
          <SearchExamplesPanel onRunExample={onSubmitSearch} />
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className={stylex.props(styles.s_883).className}>
        <div className={stylex.props(styles.s_884).className}>
          <SearchInputBox
            draftQuery={draftQuery}
            onDraftQueryChange={onDraftQueryChange}
            onSubmitSearch={onSubmitSearch}
            autoFocus={autoFocus}
          />
          {showDebug ? (
            <div className={stylex.props(styles.s_885).className}>
              <p className={stylex.props(styles.s_1005).className}>
                <span className={stylex.props(styles.s_887).className}>Parsed query</span>
                {" — "}
                chips: {chips.length}, free-text: {freeText.length}, results: {results.length}
              </p>
              {chips.length > 0 ? (
                <div>
                  <p className={stylex.props(styles.s_1005).className}>Chips</p>
                  <div className={stylex.props(styles.s_969).className}>
                    {chips.map((chip) => (
                      <Badge
                        key={`debug-${chip.id}`}
                        variant="outline"
                        xstyle={styles.s_893}
                      >
                        {chip.id}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {freeText.length > 0 ? (
                <div>
                  <p className={stylex.props(styles.s_1005).className}>Free-text tokens</p>
                  <div className={stylex.props(styles.s_969).className}>
                    {freeText.map((token) => (
                      <Badge
                        key={`ft-${token}`}
                        variant="outline"
                        xstyle={styles.s_893}
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
            <div className={stylex.props(styles.s_894).className}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setShowDebug((prev) => !prev)}
                    aria-label="Toggle search debug"
                    aria-pressed={showDebug}
                    className={stylex.props(styles.debugToggle, showDebug && styles.debugToggleOn).className}
                  >
                    <Bug className={stylex.props(styles.s_927).className} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" xstyle={styles.s_948}>
                  {showDebug ? "Hide debug" : "Show debug"}
                </TooltipContent>
              </Tooltip>
              {chips.map((chip) =>
                chip.kind === "relation" && chip.operatorLabel && chip.objectLabel ? (
                  <span
                    key={chip.id}
                    className={stylex.props(styles.s_897).className}
                    title={`Spatial relation: ${chip.operatorLabel} ${chip.objectLabel}`}
                  >
                    <span className={stylex.props(styles.s_898).className}>
                      {chip.operatorLabel}
                    </span>
                    <span className={stylex.props(styles.s_899).className}>
                      {chip.objectLabel}
                    </span>
                  </span>
                ) : (
                  <Badge
                    key={chip.id}
                    variant="secondary"
                    xstyle={styles.s_900}
                  >
                    {chip.label}
                  </Badge>
                ),
              )}
              {freeText.map((token) => (
                <Badge
                  key={`free-${token}`}
                  variant="outline"
                  xstyle={styles.s_901}
                  title="Free-text token — not matched to a structured filter"
                >
                  {token}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div className={stylex.props(styles.s_902).className}>
          {loading ? (
            <p className={stylex.props(styles.s_903).className}>
              <Loader2 className={stylex.props(styles.s_972).className} aria-hidden="true" /> Loading map data…
            </p>
          ) : (
            <div className={stylex.props(styles.s_905).className}>
              <span>Results ({results.length})</span>
              <CopyJsonButton
                payload={{ query, chips, freeText: freeText ?? [], results }}
                disabled={results.length === 0}
                label="Copy results as JSON"
              />
            </div>
          )}
          <div className={stylex.props(styles.s_906).className}>
            <div className={stylex.props(styles.s_907).className}>
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
                    className={stylex.props(styles.resultCard, selected ? styles.resultCardSelected : styles.resultCardIdle).className}
                  >
                    <div className={stylex.props(styles.s_908).className}>
                      <ResultIcon
                        className={stylex.props(styles.s_909).className}
                        aria-label={`${result.subtype} icon`}
                      />
                      <p className={stylex.props(styles.s_910).className}>
                        {result.title}
                      </p>
                      {selected ? <Check className={stylex.props(styles.s_911).className} /> : null}
                    </div>

                    <div className={stylex.props(styles.s_912).className}>
                      <div className={stylex.props(styles.s_919).className}>
                        <p className={stylex.props(styles.s_920).className}>Type</p>
                        <p className={stylex.props(styles.s_918).className}>
                          {formatFamilyLabel(result.objectFamily)}
                        </p>
                      </div>
                      <div className={stylex.props(styles.s_919).className}>
                        <p className={stylex.props(styles.s_920).className}>SubType</p>
                        <p className={stylex.props(styles.s_918).className}>{result.subtype}</p>
                      </div>
                      <div className={stylex.props(styles.s_919).className}>
                        <p className={stylex.props(styles.s_920).className}>Confidence</p>
                        <p className={stylex.props(styles.s_921).className}>
                          {Math.round(result.candidateConfidence * 100)}%
                        </p>
                      </div>
                    </div>

                    {result.exactMapAttributes.length > 0 ? (
                      <div className={stylex.props(styles.s_922).className}>
                        {result.exactMapAttributes.map((fact) => (
                          <Badge
                            key={fact}
                            variant="secondary"
                            xstyle={styles.s_923}
                          >
                            {fact}
                          </Badge>
                        ))}
                      </div>
                    ) : null}

                    {result.relatedObjectRefs && result.relatedObjectRefs.length > 0 ? (
                      <div className={stylex.props(styles.s_924).className}>
                        {result.relatedObjectRefs.slice(0, 2).map((ref) => {
                          const RefIcon = ref.subtype ? iconForSubtype(ref.subtype) : MapPin;
                          const refHighlighted =
                            highlightedRelatedObjectId === ref.objectId;
                          return (
                            <div
                              key={`${result.id}-rel-${ref.objectId}`}
                              className={stylex.props(styles.s_925).className}
                            >
                              <div
                                className={stylex.props(styles.refChip, refHighlighted ? styles.refChipOn : styles.refChipOff).className}
                                title={`${formatRelation(ref.relation)} ${ref.title ?? ref.objectId}${ref.distance_m != null ? ` (${ref.distance_m} m)` : ""}`}
                              >
                                <span className={stylex.props(styles.s_926).className}>
                                  <ArrowRight className={stylex.props(styles.s_927).className} aria-hidden="true" />
                                  <span className={stylex.props(styles.s_928).className}>{formatRelation(ref.relation)}</span>
                                </span>
                                <RefIcon
                                  className={stylex.props(styles.s_929).className}
                                  aria-hidden="true"
                                />
                                <span className={stylex.props(styles.s_930).className}>
                                  {ref.title ?? ref.objectId}
                                </span>
                                {ref.distance_m != null ? (
                                  <span className={stylex.props(styles.s_931).className}>
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
                                <div className={stylex.props(styles.s_932).className}>
                                  <span className={stylex.props(styles.s_940).className}>{ref.objectId}</span>
                                  <span>·</span>
                                  <span className={stylex.props(styles.s_940).className}>
                                    {formatGeometryRef(ref.geometryReference)}
                                  </span>
                                  <span>·</span>
                                  <span className={stylex.props(styles.s_940).className}>{formatCentroid(ref.centroid)}</span>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {showDebug ? (
                      <div className={stylex.props(styles.s_936).className}>
                        <div className={stylex.props(styles.s_937).className}>
                          <span className={stylex.props(styles.s_940).className}>{result.id}</span>
                          <span>·</span>
                          <span className={stylex.props(styles.s_940).className}>
                            {formatGeometryRef(result.geometryReference)}
                          </span>
                          <span>·</span>
                          <span className={stylex.props(styles.s_940).className}>{formatCentroid(result.centroid)}</span>
                        </div>
                        {result.matchReasons.length > 0 ? (
                          <div className={stylex.props(styles.s_941).className}>
                            match: {result.matchReasons.slice(0, 3).join(", ")}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className={stylex.props(styles.s_942).className}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            xstyle={styles.s_946}
                            onClick={(event) => {
                              event.stopPropagation();
                              onZoomToResult(result.id);
                            }}
                            aria-label="Zoom on Map"
                          >
                            <Map className={stylex.props(styles.s_991).className} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" xstyle={styles.s_948}>
                          Zoom on Map
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            xstyle={styles.s_946}
                            onClick={(event) => {
                              event.stopPropagation();
                              onUseInScenario(result.id);
                            }}
                            aria-label="Use in Scenario"
                          >
                            <Play className={stylex.props(styles.s_991).className} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" xstyle={styles.s_948}>
                          Use in Scenario
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
              {results.length === 0 ? (
                <div className={stylex.props(styles.s_949).className}>
                  {loading ? (
                    <p className={stylex.props(styles.s_950).className}>
                      <Loader2 className={stylex.props(styles.s_972).className} aria-hidden="true" /> Loading map data…
                    </p>
                  ) : (
                    <>
                      <p className={stylex.props(styles.s_1006).className}>No matching locations</p>
                      <p className={stylex.props(styles.s_953).className}>
                        Try broadening the query or removing a few constraints.
                      </p>
                      {alternativeQueries.length > 0 ? (
                        <div className={stylex.props(styles.s_954).className}>
                          <p className={stylex.props(styles.s_955).className}>Or try each term on its own:</p>
                          <div className={stylex.props(styles.s_956).className}>
                            {alternativeQueries.map((alt) => (
                              <button
                                key={alt}
                                type="button"
                                onClick={() => {
                                  onDraftQueryChange(alt);
                                  onSubmitSearch(alt);
                                }}
                                className={stylex.props(styles.s_957).className}
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
