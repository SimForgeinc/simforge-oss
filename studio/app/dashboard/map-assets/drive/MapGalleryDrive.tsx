"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CATALOG, type CatalogEntry, type CatalogId } from "@simforge-oss/asset-catalog";
import { LaneIndex, type ScenarioMapEntry } from "@simforge-oss/editor";
import { loadEngine } from "@simforge-oss/engine/browser";
import {
  CarPickerScreen,
  DRIVE_PAINT_COLORS,
  type DriveVehicleOption,
} from "@simforge-oss/studio-ui/drive";
import type { ManualDriveTakeSession } from "@simforge-oss/studio-ui/scenario/editor/manual-drive/take-handoff";
import { defaultAuthoringQuality } from "@simforge-oss/studio-ui/scenario/editor/authoring-quality";
import { RENDERING_PREFERENCE_CHANGE_EVENT } from "@simforge-oss/studio-ui/components/rendering-preference";
import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";
import { studioHost } from "@/app/lib/host";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { DriveSession } from "./DriveSession";

/** The car a drive starts in: a plain sedan is the least surprising default. */
const DEFAULT_VEHICLE = "vehicle.sedan" as CatalogId;

/**
 * Every catalog vehicle is drivable; the ones with a CARLA model lead the
 * list, because a picker that opens on a procedural box misrepresents what
 * the game looks like.
 */
const VEHICLES: readonly DriveVehicleOption[] = (CATALOG as readonly CatalogEntry[])
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
  );

/**
 * Driving, in place of the map gallery's preview: press Drive on a map and
 * the car spawns on it. The two things a session needs before it can exist —
 * the map's full entry and its lane topology — load behind the shared loading
 * surface; changing cars from the pause menu brings the picker up over the
 * session and returns to it.
 */
export function MapGalleryDrive({
  mapVersionId,
  take = null,
  onExit,
}: {
  mapVersionId: string;
  take?: ManualDriveTakeSession | null;
  onExit: () => void;
}) {
  const [map, setMap] = useState<ScenarioMapEntry | null>(null);
  const [laneIndex, setLaneIndex] = useState<LaneIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogId, setCatalogId] = useState<CatalogId>(DEFAULT_VEHICLE);
  const [color, setColor] = useState<string>(DRIVE_PAINT_COLORS[0]!);
  const [pickingCar, setPickingCar] = useState(false);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>("high");

  // Follows the shared preference so a level picked in the app switcher
  // changes this drive, not the next one.
  useEffect(() => {
    setQuality(defaultAuthoringQuality());
    const onPreference = (event: Event) =>
      setQuality((event as CustomEvent<ScenarioAuthoringQuality>).detail);
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onPreference);
    return () => window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onPreference);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setMap(null);
    setLaneIndex(null);
    setError(null);
    void studioHost.artifacts
      .listMaps(abort.signal)
      .then((installed) => {
        const entry = installed.find((candidate) => candidate.mapVersionId === mapVersionId);
        if (!entry) throw new Error("This map is not installed on this computer.");
        setMap(entry);
        return loadEngine().then((engine) =>
          LaneIndex.load(entry.topologyUrl, { engine, signal: abort.signal }),
        );
      })
      .then((index) => {
        if (!abort.signal.aborted) setLaneIndex(index);
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        toast.error("Drive could not start on this map", { description: message });
      });
    return () => abort.abort();
  }, [mapVersionId]);

  const vehicleLabel = useMemo(
    () => VEHICLES.find((vehicle) => vehicle.catalogId === catalogId)?.label ?? "Car",
    [catalogId],
  );

  if (error) {
    return (
      <CloudLoadingSurface
        detail={error}
        role="alert"
        scope="pane"
        title="Drive could not start"
      />
    );
  }
  if (!map || !laneIndex) {
    return (
      <CloudLoadingSurface
        detail={map ? `Reading the lane network of ${map.label}.` : "Finding the map on this computer."}
        scope="pane"
        title="Starting the drive…"
      />
    );
  }
  if (pickingCar) {
    return (
      <CarPickerScreen
        color={color}
        mapLabel={map.label}
        onBack={() => setPickingCar(false)}
        onColorChange={setColor}
        onSelect={setCatalogId}
        onStart={() => setPickingCar(false)}
        selectedId={catalogId}
        vehicles={VEHICLES}
      />
    );
  }
  return (
    <DriveSession
      catalogId={catalogId}
      color={color}
      laneIndex={laneIndex}
      map={map}
      onChangeCar={() => setPickingCar(true)}
      onExit={onExit}
      quality={quality}
      take={take}
      vehicleLabel={vehicleLabel}
    />
  );
}
