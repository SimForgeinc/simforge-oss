"use client";

import { useMemo } from "react";
import * as stylex from "@stylexjs/stylex";
import { viewerStyles } from "../../evaluation/run-viewer.stylex";
import type { CityViewer } from "@simforge-oss/viewer";
import type { ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";
import { DriveSession } from "../drive/DriveSession";
import { driveMapEntry } from "../drive/drive-map";
import { FREE_DRIVE_VEHICLE } from "../drive/free-drive-scenario";
import { useFreeDriveScenario } from "../drive/use-free-drive-scenario";

/** The gallery camera chooses an authored spawn only; it never controls a running episode. */
export function MapGalleryDrive({ map, viewer, mapLoaded, onExit }: {
  map: ScenarioMapDescriptorDto;
  viewer: CityViewer | null;
  mapLoaded: boolean;
  onExit: () => void;
}) {
  const entry = useMemo(() => driveMapEntry(map), [map]);
  const { scenario, error } = useFreeDriveScenario({ map: entry, catalogId: FREE_DRIVE_VEHICLE, viewer, mapLoaded });
  if (error) return <p role="alert">Cannot prepare the map scenario: {error}</p>;
  if (!scenario) return <p>Preparing authored lane placement…</p>;
  return <div {...stylex.props(viewerStyles.overlay)}><DriveSession content={scenario.content} map={entry} roleId={scenario.roleId} label={map.label} onExit={onExit} /></div>;
}
