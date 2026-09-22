"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { CatalogId } from "@simforge-oss/asset-catalog";
import { warmAuthoringRuntime, type LaneIndex, type ScenarioMapEntry } from "@simforge-oss/editor";
import { loadEngine } from "@simforge-oss/engine/browser";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type { CameraView, CityViewer } from "@simforge-oss/viewer";
import {
  createFreeDriveScenario,
  defaultFreeDriveSpawn,
  freeDriveSpawnNear,
  type FreeDriveSpawn,
} from "./free-drive-scenario";

export interface FreeDriveScenario {
  readonly laneIndex: LaneIndex;
  readonly content: ScenarioTemplateV2;
  readonly roleId: string;
}

/**
 * Everything a free drive needs that only the browser can build: the map's
 * lane index — the same immutable one the gallery tour and the editor share,
 * never fetched or decoded twice — and a scratch scenario holding one car.
 *
 * The car starts where the driver is looking. When the shared world already
 * shows this map, the spawn is the lane under the camera's point of interest,
 * facing the way the camera faces; otherwise it is the map's default runway.
 * The look is read once, as soon as the lane index is in hand — after the
 * commit that asked for the drive has settled, so a surface that leased an
 * already-loaded world in that same commit is seen as loaded, and before any
 * tour could move the camera again.
 */
export function useFreeDriveScenario({
  map,
  catalogId,
  viewer,
  mapLoaded,
}: {
  map: ScenarioMapEntry;
  catalogId: CatalogId;
  /** The shared world's viewer, read at request time only. */
  viewer: CityViewer | null;
  /** Whether that viewer currently shows `map`; a camera on another map means nothing here. */
  mapLoaded: boolean;
}): { scenario: FreeDriveScenario | null; error: string | null } {
  const [scenario, setScenario] = useState<FreeDriveScenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lookRef = useRef({ viewer, mapLoaded });
  lookRef.current = { viewer, mapLoaded };

  useEffect(() => {
    const abort = new AbortController();
    setScenario(null);
    setError(null);
    void warmAuthoringRuntime(map, loadEngine())
      .then(async (laneIndex) => {
        if (abort.signal.aborted) return;
        const look = lookRef.current;
        const view = look.mapLoaded ? look.viewer?.controls.getView() ?? null : null;
        const placed = await createFreeDriveScenario(map, laneIndex, catalogId, spawnFor(laneIndex, view));
        if (abort.signal.aborted) return;
        setScenario({ laneIndex, ...placed });
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        toast.error("The drive could not start on this map", { description: message });
      });
    return () => abort.abort();
  }, [catalogId, map]);

  return { scenario, error };
}

function spawnFor(laneIndex: LaneIndex, view: CameraView | null): FreeDriveSpawn {
  if (!view) return defaultFreeDriveSpawn(laneIndex);
  const [px, , pz] = view.position;
  const [tx, , tz] = view.target;
  // Travel-heading convention: CCW about +Y from +X, so forward is (cos h, -sin h).
  const heading = Math.atan2(-(tz - pz), tx - px);
  return freeDriveSpawnNear(laneIndex, tx, tz, heading) ?? defaultFreeDriveSpawn(laneIndex);
}
