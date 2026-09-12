"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { BarChart3, LayoutDashboard, Layers, Lightbulb, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@simforge-oss/studio-ui/components/ui/tabs";
import { MapAssetEditPanel } from "@/app/dashboard/map-assets/MapAssetEditPanel";
import { OverviewTab } from "./detail-tabs/OverviewTab";
import { LayersTab } from "./detail-tabs/LayersTab";
import { AnalyticsTab } from "./detail-tabs/AnalyticsTab";
import { InsightsTab } from "./detail-tabs/InsightsTab";
import type { MapDetailData } from "@/app/lib/maps/frontend/use-map-asset-detail-data";
import type { useMapAssetOperations } from "./useMapAssetOperations";
import type { ScenarioSummary } from "@/app/lib/scenarios";

type DetailTab = "overview" | "layers" | "analytics" | "insights";

interface MapDetailRightPanelProps {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  editMode: boolean;
  setEditMode: (mode: boolean) => void;
  currentAsset: MapAsset;
  router: AppRouterInstance;
  refreshMapAssets: () => void;
  activeTab: DetailTab;
  handleTabChange: (tab: string) => void;
  focusFamilyId: string | null;
  setFocusFamilyId: (id: string | null) => void;
  data: MapDetailData;
  ops: ReturnType<typeof useMapAssetOperations>;
  overtureCrosswalkSurvivorCount: number | undefined;
  handleSelectCandidateFromPanel: (id: string | null) => void;
  setActiveMedia: (info: { proxyUrl: string; label?: string } | null) => void;
  runs: ScenarioSummary[];
  manualHighlightedFeatureIds: number[];
  setManualHighlightedFeatureIds: (ids: number[]) => void;
  handleHighlightGuid: (guid: string) => void;
  handleSelectGuid: (guid: string) => void;
  hasGeoJSON: boolean;
}

export function MapDetailRightPanel({
  panelOpen,
  setPanelOpen,
  editMode,
  setEditMode,
  currentAsset,
  router,
  refreshMapAssets,
  activeTab,
  handleTabChange,
  focusFamilyId,
  setFocusFamilyId,
  data,
  ops,
  overtureCrosswalkSurvivorCount,
  handleSelectCandidateFromPanel,
  setActiveMedia,
  runs,
  setManualHighlightedFeatureIds,
  handleHighlightGuid,
  handleSelectGuid,
  hasGeoJSON,
}: MapDetailRightPanelProps) {
  // The lane filled/centerline toggle only applies when the map actually has a
  // lane-polygon sidecar to switch to.
  const lanePolygonsAvailable =
    Array.isArray(
      (data.lanePolygonsGeoJSON as { features?: unknown[] } | null)?.features,
    ) &&
    ((data.lanePolygonsGeoJSON as { features?: unknown[] }).features?.length ?? 0) >
      0;

  if (!panelOpen) {
    return (
      <button
        onClick={() => setPanelOpen(true)}
        className={stylex.props(styles.s_733).className}
      >
        <div className={stylex.props(styles.s_734).className}>
          <PanelRightOpen className={stylex.props(styles.s_735).className} />
          Map Attributes
        </div>
      </button>
    );
  }

  return (
    <div className={stylex.props(styles.s_736).className}>
      {/* Collapse rail */}
      {!editMode && (
        <button
          onClick={() => setPanelOpen(false)}
          className={stylex.props(styles.s_737).className}
          aria-label="Collapse panel"
        >
          <PanelRightClose className={stylex.props(styles.s_738).className} />
        </button>
      )}
      <div className={stylex.props(styles.s_739).className}>
        {editMode ? (
          <MapAssetEditPanel
            asset={currentAsset}
            onBack={() => setEditMode(false)}
            onSaved={() => {
              setEditMode(false);
              refreshMapAssets();
            }}
            onDeleted={() => {
              setEditMode(false);
              router.push("/dashboard/map-assets");
              refreshMapAssets();
            }}
          />
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className={stylex.props(styles.s_740).className}
          >
            <TabsList className={stylex.props(styles.s_741).className}>
              {([
                { value: "overview", label: "Overview", Icon: LayoutDashboard, disabled: false },
                { value: "layers", label: "Layers", Icon: Layers, disabled: false },
                { value: "analytics", label: "Stats", Icon: BarChart3, disabled: false },
                { value: "insights", label: "Insights", Icon: Lightbulb, disabled: false },
              ] as const).map(({ value, label, Icon, disabled }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  disabled={disabled}
                  className={stylex.props(styles.s_742).className}
                >
                  <Icon className={stylex.props(styles.s_760).className} />
                  <span className={stylex.props(styles.s_941).className}>{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent
              value="overview"
              className={stylex.props(styles.s_748).className}
            >
              <OverviewTab
                asset={currentAsset}
                runs={[]}
                enrichment={data.selectedEnrichment}
                enrichmentLoading={data.enrichmentLoading}
                candidateLocations={data.candidateLocations}
                candidateLocationsLoading={data.candidateLocationsLoading}
                selectedCandidateLocationId={data.selectedCandidateLocationId}
                onSelectCandidateLocationId={handleSelectCandidateFromPanel}
                onViewArtifact={(info) => setActiveMedia(info)}
                onPopulateMetadata={() => void ops.handlePopulateMetadata()}
                populateBusy={ops.populateBusy}
                populateErr={ops.populateErr}
                onSwitchToInsightsTab={(familyId) => {
                  setFocusFamilyId(familyId ?? null);
                  handleTabChange("insights");
                }}
                onSwitchToStatsTab={() => handleTabChange("analytics")}
                overtureCrosswalkSurvivors={overtureCrosswalkSurvivorCount}
              />
            </TabsContent>

            <TabsContent
              value="layers"
              className={stylex.props(styles.s_748).className}
            >
              <LayersTab
                asset={currentAsset}
                enrichment={data.selectedEnrichment}
                enrichmentLoading={data.enrichmentLoading}
                enabledFeatureTypeIds={data.enabledFeatureTypeIds}
                featureTypeCounts={data.featureTypeCounts}
                onToggleFeatureType={hasGeoJSON ? data.toggleFeatureType : undefined}
                onToggleAllFeatureTypes={hasGeoJSON ? data.toggleAllFeatureTypes : undefined}
                laneRenderMode={data.laneRenderMode}
                onSetLaneRenderMode={data.setLaneRenderMode}
                lanePolygonsAvailable={lanePolygonsAvailable}
                geojsonLoading={data.geojsonLoading}
                enabledOverlayLayerIds={data.enabledOverlayLayerIds}
                onToggleOverlayLayer={data.toggleOverlayLayer}
                candidateFamilyLayers={data.candidateFamilyLayers}
                enabledCandidateFamilyIds={data.enabledCandidateFamilyIds}
                onToggleCandidateFamily={data.toggleCandidateFamily}
                candidateLocationsLoading={data.candidateLocationsLoading}
                twinFidelityScorecard={data.twinFidelityScorecard}
                enabledTwinFidelityLayerIds={data.enabledTwinFidelityLayerIds}
                onToggleTwinFidelityLayer={data.toggleTwinFidelityLayer}
                twinFidelityRes={data.twinFidelityRes}
                onSetTwinFidelityRes={data.setTwinFidelityRes}
                speedLimitsEnabled={data.speedLimitsEnabled}
                onToggleSpeedLimits={data.toggleSpeedLimits}
                speedLimitCount={data.speedLimitCount}
                inHouseSpeedLimitsEnabled={data.inHouseSpeedLimitsEnabled}
                onToggleInHouseSpeedLimits={data.toggleInHouseSpeedLimits}
                inHouseSpeedLimitCount={data.inHouseSpeedLimitCount}
                signalOverlayGeoJSON={data.signalOverlayGeoJSON}
                enabledSignalCategories={data.enabledSignalCategories}
                signalOverlayLoading={data.signalOverlayLoading}
                onToggleSignalCategory={data.toggleSignalCategory}
                onToggleAllSignalCategories={data.toggleAllSignalCategories}
                selectedFeatures={data.selectedFeatures}
                selectedFeatureId={data.selectedFeatureId}
                onSelectFeatureId={data.setSelectedFeatureId}
                onClearSelection={() => {
                  data.setSelectedFeatures([]);
                  data.setSelectedFeatureId(null);
                  setManualHighlightedFeatureIds([]);
                  data.setSelectedCandidateLocationId(null);
                }}
                onHighlightId={handleHighlightGuid}
                onSelectId={handleSelectGuid}
                knownGuids={data.knownGuids}
                onEnrich={() => void ops.handleEnrich()}
                enrichBusy={ops.enrichBusy}
                enrichErr={ops.enrichErr}
                userGeoJsonLayers={data.userGeoJsonLayers}
                onAddUserGeoJson={data.addUserGeoJsonLayer}
                onRemoveUserGeoJson={data.removeUserGeoJsonLayer}
                onToggleUserGeoJson={data.toggleUserGeoJsonLayer}
                onSetUserGeoJsonColor={data.setUserGeoJsonLayerColor}
                onSetUserGeoJsonOpacity={data.setUserGeoJsonLayerOpacity}
                onSetUserGeoJsonThickness={data.setUserGeoJsonLayerThickness}
              />
            </TabsContent>

            <TabsContent
              value="analytics"
              className={stylex.props(styles.s_748).className}
            >
              <AnalyticsTab
                asset={currentAsset}
                candidateLocations={data.candidateLocations}
                overtureCrosswalkSurvivors={overtureCrosswalkSurvivorCount}
                enrichment={data.selectedEnrichment}
              />
            </TabsContent>

            <TabsContent
              value="insights"
              className={stylex.props(styles.s_748).className}
            >
              <InsightsTab
                asset={currentAsset}
                runs={runs}
                enrichment={data.selectedEnrichment}
                enrichmentLoading={data.enrichmentLoading}
                candidateLocations={data.candidateLocations}
                candidateLocationsLoading={data.candidateLocationsLoading}
                selectedCandidateLocationId={data.selectedCandidateLocationId}
                onSelectCandidateLocationId={handleSelectCandidateFromPanel}
                focusFamilyId={focusFamilyId}
                onClearFocusFamily={() => setFocusFamilyId(null)}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
