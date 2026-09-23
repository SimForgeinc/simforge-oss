"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";
import { DriveSession } from "../DriveSession";
import { driveMapEntry } from "../drive-map";
import { FREE_DRIVE_VEHICLE } from "../free-drive-scenario";
import { useFreeDriveScenario } from "../use-free-drive-scenario";

/** The lane index authors the scratch input; no world or WebGL viewport is created. */
export function FreeDrive({ map }: { map: ScenarioMapDescriptorDto }) {
  const router = useRouter();
  const entry = useMemo(() => driveMapEntry(map), [map]);
  const { scenario, error } = useFreeDriveScenario({ map: entry, catalogId: FREE_DRIVE_VEHICLE, viewer: null, mapLoaded: false });
  if (error) return <p role="alert">Cannot prepare the map scenario: {error}</p>;
  if (!scenario) return <p>Preparing authored lane placement…</p>;
  return <DriveSession content={scenario.content} map={entry} roleId={scenario.roleId} label={map.label} onExit={() => router.push("/dashboard/map-assets")} />;
}
