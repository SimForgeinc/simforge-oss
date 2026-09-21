"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LaneIndex, type ScenarioMapEntry } from "@simforge-oss/editor";
import { loadEngine } from "@simforge-oss/engine/browser";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { resolveScenarioMap } from "@simforge-oss/studio-host";
import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";
import { MapLoadDebugPanel } from "@simforge-oss/studio-ui/scenario/scene/MapLoadDebugPanel";
import { RENDERING_PREFERENCE_CHANGE_EVENT } from "@simforge-oss/studio-ui/components/rendering-preference";
import { defaultAuthoringQuality } from "@simforge-oss/studio-ui/scenario/editor/authoring-quality";
import { studioHost } from "@/app/lib/host";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { DriveSession } from "@/app/dashboard/map-assets/drive/DriveSession";
import { FREE_DRIVE_VEHICLE, createFreeDriveScenario } from "@/app/dashboard/map-assets/drive/free-drive-scenario";

/**
 * Driving a map for its own sake.
 *
 * Everything the session needs is built here in the browser: the installed
 * map entry, its lane topology, and a scratch scenario holding one car on the
 * longest road the map has. Nothing is persisted, nothing is recorded, and
 * leaving goes back to the maps gallery.
 */
export function FreeDrive({
  label,
  mapSourceMapId,
  mapVersionId,
  mapXodrSha256,
}: {
  label: string;
  mapSourceMapId?: string | null;
  mapVersionId: string;
  mapXodrSha256?: string | null;
}) {
  const router = useRouter();
  const [resources, setResources] = useState<{
    mapVersionId: string;
    map: ScenarioMapEntry;
    laneIndex: LaneIndex;
    content: ScenarioTemplateV2;
    roleId: string;
  } | null>(null);
  const completedResourcesRef = useRef<typeof resources>(null);
  const [error, setError] = useState<{ mapVersionId: string; message: string; cause: unknown } | null>(null);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>("medium");
  const [installedMaps, setInstalledMaps] = useState<Array<{ sourceMapId: string; mapVersionId: string }> | undefined>();

  // The level picked in the app switcher applies to this drive, exactly as it
  // does to a scenario drive.
  useEffect(() => {
    setQuality(defaultAuthoringQuality());
    const onPreference = (event: Event) =>
      setQuality((event as CustomEvent<ScenarioAuthoringQuality>).detail);
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onPreference);
    return () => window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onPreference);
  }, []);

  useEffect(() => {
    if (completedResourcesRef.current?.mapVersionId === mapVersionId) return;
    const abort = new AbortController();
    completedResourcesRef.current = null;
    setResources(null);
    setError(null);
    void studioHost.artifacts
      .listMaps(abort.signal)
      .then(async (installed) => {
        setInstalledMaps(installed.map(({ sourceMapId, mapVersionId: id }) => ({ sourceMapId, mapVersionId: id })));
        const entry = resolveScenarioMap({ mapVersionId, mapSourceMapId, mapXodrSha256 }, installed);
        const engine = await loadEngine();
        const laneIndex = await LaneIndex.load(entry.topologyUrl, { engine, signal: abort.signal });
        const scenario = await createFreeDriveScenario(entry, laneIndex, FREE_DRIVE_VEHICLE);
        return { mapVersionId, map: entry, laneIndex, ...scenario };
      })
      .then((completed) => {
        if (abort.signal.aborted) return;
        completedResourcesRef.current = completed;
        setResources(completed);
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        completedResourcesRef.current = null;
        setResources(null);
        setError({ mapVersionId, message, cause: reason });
        toast.error("The drive could not start on this map", { description: message });
      });
    return () => abort.abort();
  }, [mapVersionId, mapSourceMapId, mapXodrSha256]);

  const leave = useCallback(() => {
    router.push("/dashboard/map-assets");
  }, [router]);

  const loadingDiagnostics = <MapLoadDebugPanel source={{
    getViewer: () => null,
    mapVersionId,
    mapId: mapSourceMapId,
    installedMaps,
    requestedTier: quality,
    phase: error?.mapVersionId === mapVersionId ? "error" : "resolving",
    readinessAnnounced: false,
    error: error?.mapVersionId === mapVersionId ? error.cause : null,
  }} />;
  if (error?.mapVersionId === mapVersionId) {
    return (
      <CloudLoadingSurface
        detail={error.message}
        role="alert"
        scope="screen"
        title="The drive could not start"
        diagnostics={loadingDiagnostics}
      />
    );
  }
  if (!resources || resources.mapVersionId !== mapVersionId) {
    return (
      <CloudLoadingSurface
        detail={`Loading ${label} and its lane network.`}
        scope="screen"
        title="Loading map for drive…"
        diagnostics={loadingDiagnostics}
      />
    );
  }
  return (
    <DriveSession
      catalogId={FREE_DRIVE_VEHICLE}
      content={resources.content}
      laneIndex={resources.laneIndex}
      map={resources.map}
      mode="free"
      onExit={leave}
      quality={quality}
      roleId={resources.roleId}
      vehicleLabel="Car"
    />
  );
}
