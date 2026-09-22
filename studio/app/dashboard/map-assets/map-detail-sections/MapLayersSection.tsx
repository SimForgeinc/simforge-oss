"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./MapLayersSection.stylex";

import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Switch } from "@simforge-oss/studio-ui/components/ui/switch";
import {
  ROAD_NETWORK_FEATURE_TYPES,
  type RoadNetworkFeatureTypeId,
} from "@/app/lib/maps/frontend/road-network-feature-types";
import { SIGNAL_CATEGORY_CONFIG } from "@/app/lib/maps/frontend/signal-overlay";
import { enrichmentGlyphPath } from "@/app/components/map-assets-map/map-icons";
import type { LaneRenderMode } from "@/app/lib/maps/frontend/lane-render-mode";
import type { MapOverlayLayer, MapOverlayLayerId } from "@simforge-oss/studio-shared";
import type { ScenarioCandidateFamilyLayer } from "@/app/lib/maps/frontend/scenario-candidate-layers";
import {
  TWIN_FIDELITY_RESOLUTIONS,
  TWIN_FIDELITY_SUBLAYERS,
  twinFidelityCounts,
  type TwinFidelityScorecard,
  type TwinFidelitySubLayerId,
} from "@/app/lib/maps/frontend/twin-fidelity-layers";
import { hairline, motionRecipe, textLayout, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

const ENRICHMENT_DOTS: Record<string, string> = {
  bus_stops: "#60a5fa",
  schools: "#34d399",
  hospitals: "#f87171",
  gas_stations: "#fbbf24",
  parking_lots: "#c084fc",
  retail: "#f472b6",
  restaurant: "#fb923c",
  hotel: "#a78bfa",
  airport: "#22d3ee",
  shopping_mall: "#ec4899",
  transit_stop: "#3b82f6",
  crosswalks: "#facc15",
  sidewalks: "#4ade80",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Props for the MapLayersSection component. */
export type MapLayersSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  // Road network
  onToggleFeatureType?: (id: RoadNetworkFeatureTypeId) => void;
  enabledFeatureTypeIds: RoadNetworkFeatureTypeId[];
  featureTypeCounts: Record<RoadNetworkFeatureTypeId, number> | null;
  onToggleAllFeatureTypes?: () => void;
  geojsonLoading: boolean;
  allFeatureTypesEnabled: boolean;
  someFeatureTypesEnabled: boolean;
  roadNetworkExpanded: boolean;
  onToggleRoadNetworkExpanded: () => void;
  /** How lanes draw: filled polygons vs. authored centerlines. */
  laneRenderMode?: LaneRenderMode;
  onSetLaneRenderMode?: (mode: LaneRenderMode) => void;
  /** Whether this map has a lane-polygon sidecar (controls if the toggle shows). */
  lanePolygonsAvailable?: boolean;
  // Signals
  signalCategoryCounts: Record<string, number>;
  signalFeatureCount: number;
  enabledSignalCategories: Set<string>;
  onToggleSignalCategory?: (cat: string) => void;
  onToggleAllSignalCategories?: () => void;
  signalOverlayLoading: boolean;
  signalsLayerExpanded: boolean;
  onToggleSignalsExpanded: () => void;
  // Enrichment
  enrichmentLayers: MapOverlayLayer[];
  enrichmentProviderRelease?: string;
  enabledOverlayLayerIds: MapOverlayLayerId[];
  onToggleOverlayLayer?: (layerId: MapOverlayLayerId) => void;
  enrichmentLayersExpanded: boolean;
  onToggleEnrichmentExpanded: () => void;
  /** Optional: trigger enrichment run when no enrichment data exists yet. */
  onEnrich?: () => void;
  enrichBusy?: boolean;
  // Scenario candidates (one layer per scenario family)
  candidateFamilyLayers: ScenarioCandidateFamilyLayer[];
  enabledCandidateFamilyIds: string[];
  onToggleCandidateFamily?: (familyId: string) => void;
  candidateLocationsLoading?: boolean;
  candidatesLayerExpanded: boolean;
  onToggleCandidatesExpanded: () => void;
  // Twin fidelity (digital-twin-eval scorecard sub-layers)
  twinFidelityScorecard?: TwinFidelityScorecard | null;
  enabledTwinFidelityLayerIds?: TwinFidelitySubLayerId[];
  onToggleTwinFidelityLayer?: (id: TwinFidelitySubLayerId) => void;
  twinFidelityExpanded?: boolean;
  onToggleTwinFidelityExpanded?: () => void;
  twinFidelityRes?: number;
  onSetTwinFidelityRes?: (res: number) => void;
  // Speed limits (Overture posted limits labelled on driving lanes)
  speedLimitsEnabled?: boolean;
  onToggleSpeedLimits?: () => void;
  speedLimitCount?: number;
  // In-house (XODR) speed limits — lives in the Road Network group
  inHouseSpeedLimitsEnabled?: boolean;
  onToggleInHouseSpeedLimits?: () => void;
  inHouseSpeedLimitCount?: number;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Render toggleable map layer groups for road network, signals, and enrichment overlays. */
export function MapLayersSection(props: MapLayersSectionProps) {
  const {
    open,
    onToggleOpen,
    // Road network
    onToggleFeatureType,
    enabledFeatureTypeIds,
    featureTypeCounts,
    onToggleAllFeatureTypes,
    geojsonLoading,
    allFeatureTypesEnabled,
    someFeatureTypesEnabled,
    roadNetworkExpanded,
    onToggleRoadNetworkExpanded,
    laneRenderMode = "filled",
    onSetLaneRenderMode,
    lanePolygonsAvailable = false,
    // Signals
    signalCategoryCounts,
    signalFeatureCount,
    enabledSignalCategories,
    onToggleSignalCategory,
    onToggleAllSignalCategories,
    signalOverlayLoading,
    signalsLayerExpanded,
    onToggleSignalsExpanded,
    // Enrichment
    enrichmentLayers,
    enrichmentProviderRelease,
    enabledOverlayLayerIds,
    onToggleOverlayLayer,
    enrichmentLayersExpanded,
    onToggleEnrichmentExpanded,
    onEnrich,
    enrichBusy = false,
    // Scenario candidates
    candidateFamilyLayers,
    enabledCandidateFamilyIds,
    onToggleCandidateFamily,
    candidateLocationsLoading = false,
    candidatesLayerExpanded,
    onToggleCandidatesExpanded,
    // Twin fidelity
    twinFidelityScorecard = null,
    enabledTwinFidelityLayerIds = [],
    onToggleTwinFidelityLayer,
    twinFidelityExpanded = false,
    onToggleTwinFidelityExpanded,
    twinFidelityRes = 11,
    onSetTwinFidelityRes,
    speedLimitsEnabled = false,
    onToggleSpeedLimits,
    speedLimitCount,
    inHouseSpeedLimitsEnabled = false,
    onToggleInHouseSpeedLimits,
    inHouseSpeedLimitCount,
  } = props;

  const twinCellCounts = twinFidelityCounts(twinFidelityScorecard);
  const allTwinLayersEnabled =
    TWIN_FIDELITY_SUBLAYERS.every((sub) =>
      enabledTwinFidelityLayerIds.includes(sub.id),
    );
  const someTwinLayersEnabled = enabledTwinFidelityLayerIds.length > 0;

  // Signals derived state
  const activeCats = SIGNAL_CATEGORY_CONFIG.filter(
    (cat) => (signalCategoryCounts[cat.id] ?? 0) > 0,
  );
  const allSignalsEnabled = activeCats.every((cat) =>
    enabledSignalCategories.has(cat.id),
  );
  const someSignalsEnabled = activeCats.some((cat) =>
    enabledSignalCategories.has(cat.id),
  );

  // Enrichment derived state — exclude zero-count layers from bulk toggle
  const actionableEnrichmentLayerIds = enrichmentLayers
    .filter((layer) => layer.feature_count > 0)
    .map((layer) => layer.layer_id);
  const allEnrichmentEnabled =
    actionableEnrichmentLayerIds.length > 0 &&
    actionableEnrichmentLayerIds.every((id) =>
      enabledOverlayLayerIds.includes(id),
    );
  const someEnrichmentEnabled = actionableEnrichmentLayerIds.some((id) =>
    enabledOverlayLayerIds.includes(id),
  );

  // Scenario-candidate derived state — every family here has candidates, so
  // all rows are actionable.
  const actionableCandidateFamilyIds = candidateFamilyLayers.map((l) => l.familyId);
  const allCandidateFamiliesEnabled =
    actionableCandidateFamilyIds.length > 0 &&
    actionableCandidateFamilyIds.every((id) => enabledCandidateFamilyIds.includes(id));
  const someCandidateFamiliesEnabled = actionableCandidateFamilyIds.some((id) =>
    enabledCandidateFamilyIds.includes(id),
  );

  return (
    <section>
      <button
        type="button"
        onClick={onToggleOpen}
        {...stylex.props([motionRecipe.colors, [typography.caps, styles.mapLayersToggle]])}
        aria-expanded={open}
      >
        <ChevronRight
          {...stylex.props([motionRecipe.transform, styles.chevron], open && styles.rotate90)}
        />
        Map Layers
      </button>
      {open && (
        <ul {...stylex.props(styles.layerGroupsList)}>
          {/* ── Road Network group ── */}
          {onToggleFeatureType && (
            <>
              <li {...stylex.props([hairline.all, styles.groupHeaderRow])}>
                <button
                  type="button"
                  onClick={onToggleRoadNetworkExpanded}
                  {...stylex.props(styles.groupExpandButton)}
                  aria-expanded={roadNetworkExpanded}
                  aria-label="Toggle Road Network"
                >
                  <ChevronRight
                    {...stylex.props([motionRecipe.transform, styles.chevronMuted], roadNetworkExpanded && styles.rotate90)}
                  />
                </button>
                <span {...stylex.props([textLayout.truncate, styles.groupTitle])}>
                  Road Network
                </span>
                {geojsonLoading && (
                  <Loader2 {...stylex.props([motionRecipe.spin, styles.loadingIndicator])} />
                )}
                <Switch
                  checked={allFeatureTypesEnabled}
                  xstyle={!allFeatureTypesEnabled && someFeatureTypesEnabled && styles.partiallyEnabled}
                  onCheckedChange={onToggleAllFeatureTypes}
                  aria-label="Toggle all road network layers"
                />
              </li>
              {roadNetworkExpanded && (
                <ul {...stylex.props(styles.groupItemsList)}>
                  {/* Lane display mode: filled lane polygons vs. centerlines.
                      Only meaningful when the map has a lane-polygon sidecar. */}
                  {lanePolygonsAvailable && (
                    <li {...stylex.props([hairline.all, styles.groupHeaderRow])}>
                      <span {...stylex.props([textLayout.truncate, styles.layerLabel])}>
                        Lane display
                      </span>
                      <div
                        {...stylex.props([hairline.all, styles.laneModeToggleGroup])}
                        role="group"
                        aria-label="Lane display mode"
                      >
                        {([
                          ["filled", "Filled"],
                          ["centerlines", "Lines"],
                        ] as const).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => onSetLaneRenderMode?.(mode)}
                            aria-pressed={laneRenderMode === mode}
                            {...stylex.props([motionRecipe.colors, styles.laneModeButton], laneRenderMode === mode ? styles.laneModeButtonActive : styles.laneModeButtonIdle)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </li>
                  )}
                  {ROAD_NETWORK_FEATURE_TYPES.map((ft) => {
                    const count = featureTypeCounts?.[ft.id] ?? 0;
                    const isEnabled = enabledFeatureTypeIds.includes(ft.id);
                    return (
                      <li
                        key={ft.id}
                        {...stylex.props([hairline.all, styles.layerRow], count === 0 && styles.layerRowEmpty)}
                      >
                        <span
                          {...stylex.props(styles.layerColorDot)}
                          style={{ backgroundColor: ft.color }}
                          aria-hidden="true"
                        />
                        <span {...stylex.props([textLayout.truncate, styles.layerLabel])}>
                          {ft.label}
                        </span>
                        <span {...stylex.props(styles.layerCount)}>
                          {count.toLocaleString()}
                        </span>
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={() => onToggleFeatureType(ft.id)}
                          disabled={count === 0}
                          aria-label={`Toggle ${ft.label}`}
                        />
                      </li>
                    );
                  })}
                  {/* In-house speed limits — the XODR-authored per-lane SpeedLimit
                      (the map's own data), labelled as US-style signs. Sits with
                      the road-network layers, distinct from the Overture one. */}
                  {onToggleInHouseSpeedLimits && (
                    <li {...stylex.props([hairline.all, styles.compactLayerRow])}>
                      <span
                        {...stylex.props(styles.layerColorDot, styles.dotInHouseSpeedLimits)}
                        aria-hidden="true"
                      />
                      <span
                        {...stylex.props([textLayout.truncate, styles.layerLabel])}
                        title="XODR-authored per-lane speed limits, labelled in mph on driving lanes"
                      >
                        Speed limits (XODR)
                      </span>
                      {inHouseSpeedLimitsEnabled && inHouseSpeedLimitCount != null && (
                        <span {...stylex.props(styles.layerCount)}>
                          {inHouseSpeedLimitCount}
                        </span>
                      )}
                      <Switch
                        checked={inHouseSpeedLimitsEnabled}
                        onCheckedChange={onToggleInHouseSpeedLimits}
                        aria-label="Toggle in-house (XODR) speed limit signs"
                      />
                    </li>
                  )}
                </ul>
              )}
            </>
          )}

          {/* ── Signals & Signs group ── */}
          {signalFeatureCount > 0 && onToggleSignalCategory && (
            <>
              <li {...stylex.props([hairline.all, styles.groupHeaderRow])}>
                <button
                  type="button"
                  onClick={onToggleSignalsExpanded}
                  {...stylex.props(styles.groupExpandButton)}
                  aria-expanded={signalsLayerExpanded}
                  aria-label="Toggle Signals and Signs"
                >
                  <ChevronRight
                    {...stylex.props([motionRecipe.transform, styles.chevronMuted], signalsLayerExpanded && styles.rotate90)}
                  />
                </button>
                <span {...stylex.props([textLayout.truncate, styles.groupTitle])}>
                  Signals & Signs
                </span>
                <span {...stylex.props(styles.layerCount)}>
                  {signalFeatureCount}
                </span>
                {signalOverlayLoading && (
                  <Loader2 {...stylex.props([motionRecipe.spin, styles.loadingIndicator])} />
                )}
                <Switch
                  checked={allSignalsEnabled}
                  xstyle={!allSignalsEnabled && someSignalsEnabled && styles.partiallyEnabled}
                  onCheckedChange={onToggleAllSignalCategories}
                  aria-label="Toggle all signals"
                />
              </li>
              {signalsLayerExpanded && (
                <ul {...stylex.props(styles.groupItemsList)}>
                  {activeCats.map((cat) => {
                    const count = signalCategoryCounts[cat.id] ?? 0;
                    const isEnabled = enabledSignalCategories.has(cat.id);
                    return (
                      <li
                        key={cat.id}
                        {...stylex.props([hairline.all, styles.layerRow], count === 0 && styles.layerRowEmpty)}
                      >
                        <span
                          {...stylex.props(styles.layerColorDot)}
                          style={{ backgroundColor: cat.color }}
                          aria-hidden="true"
                        />
                        <span {...stylex.props([textLayout.truncate, styles.layerLabel])}>
                          {cat.label}
                        </span>
                        <span {...stylex.props(styles.layerCount)}>
                          {count.toLocaleString()}
                        </span>
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={() => onToggleSignalCategory(cat.id)}
                          disabled={count === 0}
                          aria-label={`Toggle ${cat.label}`}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {/* ── Enrichment Layers group ── */}
          {enrichmentLayers.length === 0 && onEnrich && (
            <li {...stylex.props(styles.enrichmentEmptyState)}>
              <p {...stylex.props(styles.enrichmentEmptyMessage)}>
                No enrichment layers yet. Run enrichment to add bus stops, schools, and hospitals.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                xstyle={styles.enrichmentActionButton}
                disabled={enrichBusy}
                onClick={onEnrich}
              >
                {enrichBusy ? (
                  <>
                    <Loader2 {...stylex.props([motionRecipe.spin, styles.enrichmentLoadingIcon])} />
                    Enriching…
                  </>
                ) : (
                  <>
                    <Sparkles {...stylex.props(styles.enrichmentActionIcon)} />
                    Run Enrichment
                  </>
                )}
              </Button>
            </li>
          )}
          {enrichmentLayers.length > 0 && (
            <>
              <li {...stylex.props([hairline.all, styles.groupHeaderRow])}>
                <button
                  type="button"
                  onClick={onToggleEnrichmentExpanded}
                  {...stylex.props(styles.groupExpandButton)}
                  aria-expanded={enrichmentLayersExpanded}
                  aria-label="Toggle Enrichment Layers"
                >
                  <ChevronRight
                    {...stylex.props([motionRecipe.transform, styles.chevronMuted], enrichmentLayersExpanded && styles.rotate90)}
                  />
                </button>
                <span {...stylex.props([textLayout.truncate, styles.groupTitle])}>
                  Enrichment Layers
                </span>
                <Switch
                  checked={allEnrichmentEnabled}
                  xstyle={!allEnrichmentEnabled && someEnrichmentEnabled && styles.partiallyEnabled}
                  onCheckedChange={() => {
                    for (const id of actionableEnrichmentLayerIds) {
                      const isOn = enabledOverlayLayerIds.includes(
                        id,
                      );
                      if (allEnrichmentEnabled ? isOn : !isOn) {
                        onToggleOverlayLayer?.(id);
                      }
                    }
                  }}
                  aria-label="Toggle all enrichment layers"
                />
              </li>
              {enrichmentLayersExpanded && (
                <ul {...stylex.props(styles.groupItemsList)}>
                  {enrichmentProviderRelease && (
                    <li {...stylex.props([typography.eyebrow, styles.providerReleaseRow])}>
                      <span>Overture</span>
                      <span {...stylex.props(styles.providerReleaseLabel)}>
                        ({enrichmentProviderRelease})
                      </span>
                    </li>
                  )}
                  {enrichmentLayers.map((layer) => {
                    const dot = ENRICHMENT_DOTS[layer.layer_id] ?? "#a3a3a3";
                    const glyphPath = enrichmentGlyphPath(layer.layer_id);
                    const isEmpty = layer.feature_count === 0;
                    return (
                      <li
                        key={layer.layer_id}
                        {...stylex.props([hairline.all, styles.layerRow], isEmpty && styles.layerRowEmpty)}
                      >
                        {glyphPath ? (
                          <span
                            {...stylex.props(styles.enrichmentGlyphDot)}
                            style={{ backgroundColor: dot }}
                            aria-hidden="true"
                          >
                            <svg
                              viewBox="0 0 15 15"
                              {...stylex.props(styles.enrichmentGlyphIcon)}
                              fill="#ffffff"
                            >
                              <path d={glyphPath} />
                            </svg>
                          </span>
                        ) : (
                          <span
                            {...stylex.props(styles.layerColorDot)}
                            style={{ backgroundColor: dot }}
                            aria-hidden="true"
                          />
                        )}
                        <span {...stylex.props([textLayout.truncate, styles.layerLabel])}>
                          {layer.label}
                        </span>
                        <span {...stylex.props(styles.layerCount)}>
                          {layer.feature_count}
                        </span>
                        <Switch
                          checked={enabledOverlayLayerIds.includes(
                            layer.layer_id,
                          )}
                          onCheckedChange={() =>
                            onToggleOverlayLayer?.(
                              layer.layer_id,
                            )
                          }
                          disabled={isEmpty}
                          aria-label={`Toggle ${layer.label} overlay`}
                        />
                      </li>
                    );
                  })}
                  {/* Overture posted speed limits, drawn as mph labels on lanes.
                      A street fact (not an overlay_payload layer), so it rides
                      its own toggle/fetch but lives with the Overture layers. */}
                  {onToggleSpeedLimits && (
                    <li {...stylex.props([hairline.all, styles.compactLayerRow])}>
                      <span
                        {...stylex.props(styles.layerColorDot, styles.dotOvertureSpeedLimits)}
                        aria-hidden="true"
                      />
                      <span
                        {...stylex.props([textLayout.truncate, styles.layerLabel])}
                        title="Overture posted speed limits (blue border), labelled on driving lanes"
                      >
                        Speed limits (Overture)
                      </span>
                      {speedLimitsEnabled && speedLimitCount != null && (
                        <span
                          {...stylex.props(styles.layerCount)}
                          title="driving lanes with a posted Overture limit"
                        >
                          {speedLimitCount}
                        </span>
                      )}
                      <Switch
                        checked={speedLimitsEnabled}
                        onCheckedChange={onToggleSpeedLimits}
                        aria-label="Toggle speed limit labels"
                      />
                    </li>
                  )}
                </ul>
              )}
            </>
          )}

          {/* ── Scenario Candidates group ── */}
          {candidateFamilyLayers.length > 0 && (
            <>
              <li {...stylex.props([hairline.all, styles.groupHeaderRow])}>
                <button
                  type="button"
                  onClick={onToggleCandidatesExpanded}
                  {...stylex.props(styles.groupExpandButton)}
                  aria-expanded={candidatesLayerExpanded}
                  aria-label="Toggle Scenario Candidates"
                >
                  <ChevronRight
                    {...stylex.props([motionRecipe.transform, styles.chevronMuted], candidatesLayerExpanded && styles.rotate90)}
                  />
                </button>
                <span {...stylex.props([textLayout.truncate, styles.groupTitle])}>
                  Scenario Candidates
                </span>
                {candidateLocationsLoading && (
                  <Loader2 {...stylex.props([motionRecipe.spin, styles.loadingIndicator])} />
                )}
                <Switch
                  checked={allCandidateFamiliesEnabled}
                  xstyle={!allCandidateFamiliesEnabled && someCandidateFamiliesEnabled && styles.partiallyEnabled}
                  onCheckedChange={() => {
                    for (const id of actionableCandidateFamilyIds) {
                      const isOn = enabledCandidateFamilyIds.includes(id);
                      if (allCandidateFamiliesEnabled ? isOn : !isOn) {
                        onToggleCandidateFamily?.(id);
                      }
                    }
                  }}
                  aria-label="Toggle all scenario candidate layers"
                />
              </li>
              {candidatesLayerExpanded && (
                <ul {...stylex.props(styles.groupItemsList)}>
                  {candidateFamilyLayers.map((layer) => (
                    <li
                      key={layer.familyId}
                      {...stylex.props([hairline.all, styles.compactLayerRow])}
                    >
                      <span
                        {...stylex.props(styles.layerColorDot, styles.dotScenarioCandidate)}
                        aria-hidden="true"
                      />
                      <span {...stylex.props([textLayout.truncate, styles.layerLabel])}>
                        {layer.label}
                      </span>
                      <span {...stylex.props(styles.layerCount)}>
                        {layer.count.toLocaleString()}
                      </span>
                      <Switch
                        checked={enabledCandidateFamilyIds.includes(layer.familyId)}
                        onCheckedChange={() => onToggleCandidateFamily?.(layer.familyId)}
                        aria-label={`Toggle ${layer.label} candidates`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {/* ── Twin Fidelity group (digital-twin-eval scorecard) ── */}
          {twinFidelityScorecard && (
            <>
              <li {...stylex.props([hairline.all, styles.groupHeaderRow])}>
                <button
                  type="button"
                  onClick={onToggleTwinFidelityExpanded}
                  {...stylex.props(styles.groupExpandButton)}
                  aria-expanded={twinFidelityExpanded}
                  aria-label="Toggle Twin Fidelity"
                >
                  <ChevronRight
                    {...stylex.props([motionRecipe.transform, styles.chevronMuted], twinFidelityExpanded && styles.rotate90)}
                  />
                </button>
                <span {...stylex.props([textLayout.truncate, styles.groupTitle])}>
                  Twin Fidelity
                </span>
                <span
                  {...stylex.props(styles.layerCount)}
                  title="scored cells / total cells with drive coverage"
                >
                  {twinCellCounts.scored}/{twinCellCounts.total}
                </span>
                <Switch
                  checked={allTwinLayersEnabled}
                  xstyle={!allTwinLayersEnabled && someTwinLayersEnabled && styles.partiallyEnabled}
                  onCheckedChange={() => {
                    for (const sub of TWIN_FIDELITY_SUBLAYERS) {
                      const isOn = enabledTwinFidelityLayerIds.includes(sub.id);
                      if (allTwinLayersEnabled ? isOn : !isOn) {
                        onToggleTwinFidelityLayer?.(sub.id);
                      }
                    }
                  }}
                  aria-label="Toggle all twin fidelity layers"
                />
              </li>
              {twinFidelityExpanded && (
                <ul {...stylex.props(styles.groupItemsList)}>
                  <li {...stylex.props([typography.eyebrow, styles.twinMetadataRow])}>
                    {twinFidelityScorecard.properties.twin_build_id}
                    <span {...stylex.props(styles.twinReferenceVersion)}>
                      vs {twinFidelityScorecard.properties.ref_version}
                    </span>
                  </li>
                  {TWIN_FIDELITY_SUBLAYERS.map((sub) => (
                    <li
                      key={sub.id}
                      {...stylex.props([hairline.all, styles.compactLayerRow])}
                    >
                      <span
                        {...stylex.props(styles.layerColorDot)}
                        style={{ backgroundColor: sub.dot }}
                        aria-hidden="true"
                      />
                      <span
                        {...stylex.props([textLayout.truncate, styles.layerLabel])}
                        title={sub.description}
                      >
                        {sub.label}
                      </span>
                      <Switch
                        checked={enabledTwinFidelityLayerIds.includes(sub.id)}
                        onCheckedChange={() => onToggleTwinFidelityLayer?.(sub.id)}
                        aria-label={`Toggle ${sub.label} layer`}
                      />
                    </li>
                  ))}
                  <li {...stylex.props(styles.resolutionSelectorRow)}>
                    <span {...stylex.props([typography.eyebrow, styles.resolutionLabel])}>
                      Cell size
                    </span>
                    {TWIN_FIDELITY_RESOLUTIONS.map((r) => (
                      <button
                        key={r.res}
                        type="button"
                        onClick={() => onSetTwinFidelityRes?.(r.res)}
                        {...stylex.props(styles.resolutionButton, twinFidelityRes === r.res ? styles.resolutionButtonActive : styles.resolutionButtonIdle)}
                        aria-pressed={twinFidelityRes === r.res}
                        aria-label={`Set twin fidelity cell size to ${r.label}`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </li>
                  <li {...stylex.props(styles.twinFidelityLegend)}>
                    0–100 = % of real lidar within 1 m of the twin · grey = no
                    twin coverage
                  </li>
                </ul>
              )}
            </>
          )}
        </ul>
      )}
    </section>
  );
}
