"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CATALOG, type CatalogEntry, type CatalogId } from "@simforge-oss/asset-catalog";
import { LaneIndex, type ScenarioMapEntry } from "@simforge-oss/editor";
import { loadEngine } from "@simforge-oss/engine/browser";
import {
  CarPickerScreen,
  DRIVE_PAINT_COLORS,
  MapPickerScreen,
  type DriveMapOption,
  type DriveVehicleOption,
} from "@simforge-oss/studio-ui/drive";
import { defaultAuthoringQuality } from "@simforge-oss/studio-ui/scenario/editor/authoring-quality";
import type { StudioMapEntry } from "@simforge-oss/studio-host";
import { studioHost } from "@/app/lib/host";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { DriveSession } from "./DriveSession";

/** The car the picker offers first: a plain sedan is the least surprising default. */
const DEFAULT_VEHICLE = "vehicle.sedan" as CatalogId;

/**
 * `/drive` — map, car, drive.
 *
 * Owns the three screens and the two things a session needs before it can
 * exist: the installed map catalog and that map's lane topology. The topology
 * is loaded while the player is choosing a car, which is the only reason the
 * car picker is a separate screen rather than a panel.
 */
export function DriveApp() {
  const [maps, setMaps] = useState<readonly StudioMapEntry[] | null>(null);
  const [mapsError, setMapsError] = useState<string | null>(null);
  const [mapVersionId, setMapVersionId] = useState<string | null>(null);
  const [laneIndex, setLaneIndex] = useState<LaneIndex | null>(null);
  const [laneError, setLaneError] = useState<string | null>(null);
  const [catalogId, setCatalogId] = useState<CatalogId>(DEFAULT_VEHICLE);
  const [color, setColor] = useState<string>(DRIVE_PAINT_COLORS[0]!);
  const [driving, setDriving] = useState(false);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>("minimal");

  useEffect(() => setQuality(defaultAuthoringQuality()), []);

  useEffect(() => {
    const abort = new AbortController();
    void studioHost.artifacts.listMaps(abort.signal)
      .then((installed) => setMaps(installed))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setMapsError(errorMessage(error));
      });
    return () => abort.abort();
  }, []);

  const map = useMemo<ScenarioMapEntry | null>(
    () => maps?.find((candidate) => candidate.mapVersionId === mapVersionId) ?? null,
    [mapVersionId, maps],
  );

  useEffect(() => {
    if (!map) {
      setLaneIndex(null);
      return;
    }
    const abort = new AbortController();
    setLaneError(null);
    setLaneIndex(null);
    void loadEngine()
      .then((engine) => LaneIndex.load(map.topologyUrl, { engine, signal: abort.signal }))
      .then((index) => {
        if (!abort.signal.aborted) setLaneIndex(index);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setLaneError(errorMessage(error));
        toast.error("Drive could not load the lane network", { description: errorMessage(error) });
      });
    return () => abort.abort();
  }, [map]);

  // Every catalog vehicle is drivable; the ones with a CARLA model lead the
  // list, because a picker that opens on a procedural box misrepresents what
  // the game looks like.
  const vehicles = useMemo<readonly DriveVehicleOption[]>(
    () => (CATALOG as readonly CatalogEntry[])
      .filter((entry) => entry.class === "vehicle")
      .map((entry) => ({
        catalogId: entry.id as CatalogId,
        label: entry.label,
        description: entry.description,
        dims: entry.dims,
        modelled: entry.model?.kind === "glb",
      }))
      .sort((left, right) =>
        Number(right.modelled) - Number(left.modelled) || left.label.localeCompare(right.label),
      ),
    [],
  );

  const mapOptions = useMemo<readonly DriveMapOption[]>(
    () => (maps ?? []).map((entry) => ({
      mapVersionId: entry.mapVersionId,
      label: entry.label,
      locality: entry.locality || null,
      thumbnailUrl: entry.thumbnailUrl,
    })),
    [maps],
  );

  const exit = useCallback(() => {
    setDriving(false);
    setMapVersionId(null);
  }, []);

  if (!map) {
    return (
      <MapPickerScreen
        error={mapsError}
        loading={maps === null}
        maps={mapOptions}
        onPick={setMapVersionId}
      />
    );
  }

  if (!driving || !laneIndex) {
    return (
      <CarPickerScreen
        color={color}
        mapLabel={laneError ?? (laneIndex ? map.label : `${map.label} · loading lanes…`)}
        onBack={exit}
        onColorChange={setColor}
        onSelect={setCatalogId}
        onStart={() => setDriving(true)}
        selectedId={catalogId}
        vehicles={vehicles}
      />
    );
  }

  return (
    <DriveSession
      catalogId={catalogId}
      color={color}
      laneIndex={laneIndex}
      map={map}
      onChangeCar={() => setDriving(false)}
      onExit={exit}
      quality={quality}
      vehicleLabel={vehicles.find((vehicle) => vehicle.catalogId === catalogId)?.label ?? "Car"}
    />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
