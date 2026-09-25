"use client";

import type { LucideIcon } from "lucide-react";
import type { ScenarioEditorActorDraft } from "@simforge-oss/studio-shared";
import type { BridgedMapBundle } from "@/app/lib/editor-map/types";
import type { ScenarioSimulationStreamMessage } from "@/app/lib/runtime/runtime-types";
import type { NormalizedScenarioDraft } from "@/app/lib/scenario-editor/draft-normalization";

export type WorkspaceTab = "datasets" | "editor" | "render";
export type SidebarMode = "manual";
export type SlidePanelMode = "json" | "settings" | "templates" | null;
export type SceneObjectType = "actor" | "prop" | "camera";
export type CameraPlacementMode = "overhead" | "street";

export type SemanticEditorBootstrapSummary = {
  contract: "simforge.semantic-editor-bootstrap.v1";
  publicationRevision: string;
  semanticMapGraphRevision: string;
  semanticFeatureGraphRevision: string;
  semanticExecutionIndexRevision: string;
  runtimeMapName: string;
  runtimeCatalogVersion: string;
  capabilities: {
    road_authoring: boolean;
    timed_instructions: boolean;
    semantic_instruction_program: boolean;
    lane_change: boolean;
    runtime_debug: boolean;
  };
};

export type MapBundleResponse = Pick<
  BridgedMapBundle,
  | "asset"
  | "bundle_version"
  | "runtime_bundle_key"
  | "locations"
  | "bridge_summary"
  | "carla_status"
  | "map_match"
  | "generated"
  | "runtime"
  | "street_furniture"
  | "enrichment"
  | "candidate_locations"
  | "signals_geojson"
  | "geojson_url"
> & {
  /** Present on the semantic-first boot path. Runtime geometry is deliberately
   * absent; exact CARLA bindings remain server/worker execution artifacts. */
  semantic_bootstrap?: SemanticEditorBootstrapSummary;
};

export type ActorPaletteCategory =
  | "Traffic Safety"
  | "Debris"
  | "Containers & Storage"
  | "Street Furniture"
  | "Vegetation";

export type ActorPaletteItem = {
  id: string;
  label: string;
  description: string;
  kind: ScenarioEditorActorDraft["kind"];
  role: ScenarioEditorActorDraft["role"];
  objectType: SceneObjectType;
  /**
   * How a drop resolves to a spawn — the ONLY placement decision the palette
   * still makes. `lane_or_free` snaps onto the OpenDRIVE lane under the pointer
   * and falls back to a freeform world point when the drop lands off-road;
   * `free` never snaps. Everything else about the actor (Drive, Walk, Parked,
   * or a freeform point path) is its BASE CLIP — editable for the actor's whole
   * life — not a palette fork. See `behavior-base-clip.ts`.
   */
  placement: "lane_or_free" | "free";
  isStatic?: boolean;
  blueprint: string;
  color: string;
  icon: LucideIcon;
  category?: ActorPaletteCategory;
};

export type EditorActorRecord = {
  draft: ScenarioEditorActorDraft;
  lng: number;
  lat: number;
  placementLabel: string;
};

export type PaletteDragState = {
  item: ActorPaletteItem;
  pointerId: number;
  originX: number;
  originY: number;
  clientX: number;
  clientY: number;
  dragActive: boolean;
};

export type ActorDragState = {
  actorId: string;
  originX: number;
  originY: number;
  clientX: number;
  clientY: number;
  dragActive: boolean;
};

export type CameraPaletteDragState = {
  mode: CameraPlacementMode;
  pointerId: number;
  originX: number;
  originY: number;
  clientX: number;
  clientY: number;
  dragActive: boolean;
};

export type WorldSensorRecord = NormalizedScenarioDraft["worldSensors"][number];

export type LocalTemplateRecord = {
  id: string;
  name: string;
  createdAt: string;
  mapName: string;
  actors: ScenarioEditorActorDraft[];
  worldSensors: NormalizedScenarioDraft["worldSensors"];
};

export type PreviewFrame = {
  frame: number;
  timestamp: number;
  actors: ScenarioSimulationStreamMessage["actors"];
};

export type PageLogEntryCategory =
  | "command_error"
  | "terminal_job_error"
  | "config_blocker"
  | "background_stale"
  | "background_degraded"
  | "material_outage"
  | "activity";

export type PageLogEntry = {
  id: string;
  timestamp: string;
  scope: "app" | "simulate" | "render" | "cosmos" | "system";
  level: "info" | "warn" | "error";
  category: PageLogEntryCategory;
  surface?: string | null;
  scopeKey?: string | null;
  message: string;
};
