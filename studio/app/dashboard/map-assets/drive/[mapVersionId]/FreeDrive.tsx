"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import * as stylex from "@stylexjs/stylex";
import type { CityViewer } from "@simforge-oss/viewer";
import { renderingPreferenceQuality, useRenderingPreference } from "@simforge-oss/studio-ui/components/rendering-preference";
import type {
  ScenarioWorldState,
  ScenarioWorldTarget,
} from "@simforge-oss/studio-ui/scenario/scene/ScenarioWorldHost";
import {
  EMPTY_WORLD_STATE,
  ScenarioWorldSurface,
} from "@simforge-oss/studio-ui/scenario/scene/ScenarioWorldProvider";
import type { ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";
import { DriveSession } from "@/app/dashboard/map-assets/drive/DriveSession";
import { driveMapEntry } from "@/app/dashboard/map-assets/drive/drive-map";
import { driveFrame } from "@/app/dashboard/map-assets/drive/drive-session.stylex";
import { FREE_DRIVE_VEHICLE } from "@/app/dashboard/map-assets/drive/free-drive-scenario";
import { useFreeDriveScenario } from "@/app/dashboard/map-assets/drive/use-free-drive-scenario";

/** A drive route draws its own car; the world's placed-actor renderer is not its concern. */
function ignoreActorRenderer(): void {}

/**
 * Driving a map for its own sake, reached by URL.
 *
 * The route leases the dashboard's shared world exactly as the gallery does,
 * so the map the gallery was just showing carries on without a reload, and
 * any other map is loaded once into that same viewer — never a second one.
 * Everything else the session needs is built here in the browser from the
 * descriptor the page resolved: the lane topology and a scratch scenario
 * holding one car. Nothing is persisted, nothing is recorded, and leaving
 * goes back to the maps gallery.
 */
export function FreeDrive({ map }: { map: ScenarioMapDescriptorDto }) {
  const router = useRouter();
  const quality = renderingPreferenceQuality(useRenderingPreference() ?? "medium");
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [worldState, setWorldState] = useState<ScenarioWorldState>(EMPTY_WORLD_STATE);
  const entry = useMemo(() => driveMapEntry(map), [map]);
  const target = useMemo<ScenarioWorldTarget>(() => ({
    mapId: map.sourceMapId,
    mapVersionId: map.mapVersionId,
    manifestUrl: map.browserManifestUrl,
    label: map.label,
    locality: map.locality,
  }), [map]);
  const mapLoaded = worldState.loadedMapVersionId === map.mapVersionId;
  const { scenario } = useFreeDriveScenario({ map: entry, catalogId: FREE_DRIVE_VEHICLE, viewer, mapLoaded });

  const leave = useCallback(() => {
    router.push("/dashboard/map-assets");
  }, [router]);

  return (
    <div {...stylex.props(driveFrame.route)}>
      <ScenarioWorldSurface
        className={stylex.props(driveFrame.world).className}
        interactive={false}
        onActorRendererChange={ignoreActorRenderer}
        onStateChange={setWorldState}
        onViewerChange={setViewer}
        target={target}
      />
      {scenario ? (
        <DriveSession
          catalogId={FREE_DRIVE_VEHICLE}
          content={scenario.content}
          laneIndex={scenario.laneIndex}
          map={entry}
          mapLoaded={mapLoaded}
          mode="free"
          onExit={leave}
          quality={quality}
          roleId={scenario.roleId}
          vehicleLabel="Car"
          viewer={viewer}
        />
      ) : null}
    </div>
  );
}
