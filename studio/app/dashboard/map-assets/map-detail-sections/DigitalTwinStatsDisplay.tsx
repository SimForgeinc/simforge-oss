"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

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
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import type { ThreeDStats as ThreeDStatsResponse } from "@/app/lib/3d-manifest-stats";

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
        className={stylex.props(styles.s_634).className}
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <Icon className={stylex.props(styles.s_635).className} />
        <span className={stylex.props(styles.s_636).className}>{label}</span>
      </button>
      {open && <div className={stylex.props(styles.s_637).className}>{children}</div>}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={stylex.props(styles.s_648).className}>
      <span className={stylex.props(styles.s_973).className}>{label}</span>
      <span className={stylex.props(styles.s_650).className}>{value}</span>
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
    <div className={stylex.props(styles.s_641).className}>
      {/* Expand / Collapse all */}
      <div className={stylex.props(styles.s_642).className}>
        <button
          type="button"
          onClick={toggleAll}
          className={stylex.props(styles.s_643).className}
        >
          <ChevronsUpDown className={stylex.props(styles.s_927).className} />
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
        <div className={stylex.props(styles.s_645).className}>
          <p className={stylex.props(styles.s_646).className}>
            Per-LOD Summary
          </p>
          <div className={stylex.props(styles.s_925).className}>
            {stats.lodSummaries.map((lod) => (
              <div key={lod.level} className={stylex.props(styles.s_648).className}>
                <span className={stylex.props(styles.s_973).className}>
                  LOD{lod.level}
                </span>
                <span className={stylex.props(styles.s_650).className}>
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
        <div className={stylex.props(styles.s_651).className}>
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
        <div className={stylex.props(styles.s_652).className}>
          <p className={stylex.props(styles.s_664).className}>
            No object-level semantic counts available (buildings, props, signage).
          </p>
          <p className={stylex.props(styles.s_664).className}>
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
    strong: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
    moderate: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    limited: "bg-muted text-muted-foreground border-border",
  };

  return (
    <div>
      <div className={stylex.props(styles.s_655).className}>
        <span
          className={stylex.props(styles.u_927, styles.u_928, styles.u_955, styles.u_935, styles.u_947, styles.u_962, styles.u_903).className}
        >
          {strength}
        </span>
        <span className={stylex.props(styles.s_827).className}>{label}</span>
      </div>
      <p className={stylex.props(styles.s_657).className}>
        {description}
      </p>
    </div>
  );
}
