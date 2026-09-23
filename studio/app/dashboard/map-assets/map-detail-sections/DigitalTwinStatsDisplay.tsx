"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./DigitalTwinStatsDisplay.stylex";

import { useState, useCallback } from "react";
import {
  Box,
  Grid3X3,
  Maximize2,
  TreePine,
  Zap,
  Info,
  ChevronRight,
  ChevronsUpDown,
} from "lucide-react";
import type { ThreeDStats as ThreeDStatsResponse } from "@/app/lib/3d-manifest-stats";
import { motionRecipe, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function fmtMeters(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m.toFixed(0)} m`;
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function CollapsibleSection({
  icon: Icon,
  label,
  open,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        {...stylex.props(styles.collapsibleSectionToggle)}
        aria-expanded={open}
      >
        <ChevronRight
          {...stylex.props([motionRecipe.transform, styles.chevronMutedShrink], open && styles.rotate90)}
        />
        <Icon {...stylex.props(styles.sectionIcon)} />
        <span {...stylex.props(styles.sectionLabel)}>{label}</span>
      </button>
      {open && <div {...stylex.props(styles.sectionContent)}>{children}</div>}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div {...stylex.props(styles.statRow)}>
      <span {...stylex.props(styles.statLabel)}>{label}</span>
      <span {...stylex.props(styles.statValue)}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type SectionKey = "complexity" | "tiling" | "footprint" | "vegetation" | "readiness" | "limitations";
const ALL_SECTIONS: SectionKey[] = ["complexity", "tiling", "footprint", "vegetation", "readiness", "limitations"];

export function DigitalTwinStatsDisplay({ stats }: { stats: ThreeDStatsResponse }) {
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(ALL_SECTIONS));

  const toggle = useCallback((key: SectionKey) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const allExpanded = openSections.size === ALL_SECTIONS.length;

  function toggleAll() {
    setOpenSections(allExpanded ? new Set() : new Set(ALL_SECTIONS));
  }

  // Derived values
  const coverageArea = stats.sceneDimensions.widthM * stats.sceneDimensions.depthM;

  return (
    <div {...stylex.props(styles.statsContainer)}>
      {/* Expand / Collapse all */}
      <div {...stylex.props(styles.expansionControls)}>
        <button
          type="button"
          onClick={toggleAll}
          {...stylex.props([motionRecipe.colors, styles.expandCollapseButton])}
        >
          <ChevronsUpDown {...stylex.props(styles.expandCollapseIcon)} />
          {allExpanded ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {/* Scene Complexity */}
      <CollapsibleSection
        icon={Box}
        label="Scene Complexity"
        open={openSections.has("complexity")}
        onToggle={() => toggle("complexity")}
      >
        <StatRow label="Total triangles" value={fmt(stats.totalTriangles)} />
        <StatRow label="Avg / tile" value={fmt(stats.avgTrianglesPerTile)} />
        <StatRow label="Max tile" value={fmt(stats.maxTileTriangles)} />
        <StatRow label="Min tile" value={fmt(stats.minTileTriangles)} />
        {stats.staticLayers.map((layer) => (
          <StatRow
            key={layer.id}
            label={`${layer.id.charAt(0).toUpperCase() + layer.id.slice(1)} layer`}
            value={`${fmt(layer.triangles)} tris`}
          />
        ))}
      </CollapsibleSection>

      {/* Tiling + LOD */}
      <CollapsibleSection
        icon={Grid3X3}
        label="Tiling + LOD"
        open={openSections.has("tiling")}
        onToggle={() => toggle("tiling")}
      >
        <StatRow
          label="Grid"
          value={`${stats.gridDimensions[0]} × ${stats.gridDimensions[1]}`}
        />
        <StatRow label="Tiles" value={String(stats.tileCount)} />
        <StatRow label="LOD levels" value={String(stats.lodLevels)} />

        {/* Per-LOD summary table */}
        <div {...stylex.props(styles.lodSummary)}>
          <p {...stylex.props([typography.eyebrow, styles.lodSummaryTitle])}>
            Per-LOD Summary
          </p>
          <div {...stylex.props(styles.lodSummaryRows)}>
            {stats.lodSummaries.map((lod) => (
              <div key={lod.level} {...stylex.props(styles.statRow)}>
                <span {...stylex.props(styles.statLabel)}>
                  LOD{lod.level}
                </span>
                <span {...stylex.props(styles.statValue)}>
                  {fmt(lod.totalTriangles)} tris &middot; {fmtBytes(lod.totalFileSize)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </CollapsibleSection>

      {/* Footprint / Scale */}
      <CollapsibleSection
        icon={Maximize2}
        label="Footprint / Scale"
        open={openSections.has("footprint")}
        onToggle={() => toggle("footprint")}
      >
        <StatRow
          label="Cell size"
          value={`${stats.cellSize[0].toFixed(0)} × ${stats.cellSize[1].toFixed(0)} m`}
        />
        <StatRow
          label="Scene extent"
          value={`${fmtMeters(stats.sceneDimensions.widthM)} × ${fmtMeters(stats.sceneDimensions.depthM)}`}
        />
        <StatRow
          label="Height range"
          value={fmtMeters(stats.sceneDimensions.heightM)}
        />
        <StatRow
          label="Coverage area"
          value={
            coverageArea >= 1e6
              ? `${(coverageArea / 1e6).toFixed(2)} km²`
              : `${fmt(Math.round(coverageArea))} m²`
          }
        />
      </CollapsibleSection>

      {/* Vegetation / Occlusion */}
      {stats.hasVegetation && (
        <CollapsibleSection
          icon={TreePine}
          label="Vegetation / Occlusion"
          open={openSections.has("vegetation")}
          onToggle={() => toggle("vegetation")}
        >
          <StatRow label="Vegetation tiles" value={String(stats.vegetationTileCount)} />
          <StatRow label="Total instances" value={fmt(stats.totalVegetationInstances)} />
          <StatRow label="Avg / tile" value={fmt(stats.avgVegetationInstancesPerTile)} />
          {stats.vegetationPrototypes.map((proto) => (
            <StatRow
              key={proto.meshName}
              label={proto.meshName}
              value={`${fmt(proto.totalInstances)} instances`}
            />
          ))}
        </CollapsibleSection>
      )}

      {/* Scenario Readiness */}
      <CollapsibleSection
        icon={Zap}
        label="Scenario Readiness"
        open={openSections.has("readiness")}
        onToggle={() => toggle("readiness")}
      >
        <div {...stylex.props(styles.readinessSignals)}>
          <ReadinessSignal
            label="Visual richness"
            description={
              stats.totalTriangles > 500_000
                ? "High scene complexity supports detailed urban inspection"
                : "Moderate scene complexity suitable for layout review"
            }
            strength={stats.totalTriangles > 500_000 ? "strong" : "moderate"}
          />
          <ReadinessSignal
            label="Occlusion review"
            description={
              stats.hasVegetation && stats.totalVegetationInstances > 100
                ? "Vegetation density supports hidden-pedestrian and sightline analysis"
                : stats.hasVegetation
                  ? "Some vegetation present for basic occlusion scenarios"
                  : "No vegetation data — occlusion review limited to built structures"
            }
            strength={
              stats.hasVegetation && stats.totalVegetationInstances > 100
                ? "strong"
                : stats.hasVegetation
                  ? "moderate"
                  : "limited"
            }
          />
          <ReadinessSignal
            label="Browser inspection"
            description={
              stats.lodLevels >= 3
                ? "Multi-LOD tiling enables smooth interactive streaming"
                : "Limited LOD structure may affect streaming performance"
            }
            strength={stats.lodLevels >= 3 ? "strong" : "moderate"}
          />
        </div>
      </CollapsibleSection>

      {/* Known Limitations */}
      <CollapsibleSection
        icon={Info}
        label="Known Limitations"
        open={openSections.has("limitations")}
        onToggle={() => toggle("limitations")}
      >
        <div {...stylex.props(styles.limitationsList)}>
          <p {...stylex.props(styles.limitationItem)}>
            No object-level semantic counts available (buildings, props, signage).
          </p>
          <p {...stylex.props(styles.limitationItem)}>
            Material and texture inventory not included in manifest.
          </p>
        </div>
      </CollapsibleSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Readiness signal chip
// ---------------------------------------------------------------------------

function ReadinessSignal({
  label,
  description,
  strength,
}: {
  label: string;
  description: string;
  strength: "strong" | "moderate" | "limited";
}) {
  const colorMap = {
    strong: styles.strengthStrong,
    moderate: styles.strengthModerate,
    limited: styles.strengthLimited,
  };

  return (
    <div>
      <div {...stylex.props(styles.readinessSignalHeader)}>
        <span
          {...stylex.props(styles.strengthBadge, colorMap[strength])}
        >
          {strength}
        </span>
        <span {...stylex.props(styles.readinessSignalLabel)}>{label}</span>
      </div>
      <p {...stylex.props(styles.readinessSignalDescription)}>
        {description}
      </p>
    </div>
  );
}
