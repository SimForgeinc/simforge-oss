"use client";

import { useEffect, useMemo } from "react";
import type { CityViewer } from "@simforge-oss/viewer";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import type { ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";
import { DriveSession } from "@/app/dashboard/map-assets/drive/DriveSession";
import { driveMapEntry } from "@/app/dashboard/map-assets/drive/drive-map";
import { FREE_DRIVE_VEHICLE } from "@/app/dashboard/map-assets/drive/free-drive-scenario";
import { useFreeDriveScenario } from "@/app/dashboard/map-assets/drive/use-free-drive-scenario";

/**
 * Drive mode over the gallery's own world.
 *
 * The map on screen is the map that gets driven: nothing is navigated to and
 * nothing is reloaded. The car is placed on the lane the gallery camera was
 * looking at and the session's chrome goes over the same canvas, so the
 * takeover is one commit — the gallery's hero and controls step aside, the
 * HUD steps in. Leaving hands the same world back to the gallery.
 */
export function MapGalleryDrive({
  map,
  quality,
  viewer,
  mapLoaded,
  onExit,
}: {
  map: ScenarioMapDescriptorDto;
  quality: ScenarioAuthoringQuality;
  viewer: CityViewer | null;
  mapLoaded: boolean;
  onExit: () => void;
}) {
  const entry = useMemo(() => driveMapEntry(map), [map]);
  const { scenario, error } = useFreeDriveScenario({ map: entry, catalogId: FREE_DRIVE_VEHICLE, viewer, mapLoaded });

  // A map with nowhere to put a car has already said so in a toast; there is
  // nothing to stay in drive mode for.
  useEffect(() => {
    if (error) onExit();
  }, [error, onExit]);

  if (!scenario) return null;
  return (
    <DriveSession
      catalogId={FREE_DRIVE_VEHICLE}
      content={scenario.content}
      laneIndex={scenario.laneIndex}
      map={entry}
      mapLoaded={mapLoaded}
      mode="free"
      onExit={onExit}
      quality={quality}
      roleId={scenario.roleId}
      vehicleLabel="Car"
      viewer={viewer}
    />
  );
}
