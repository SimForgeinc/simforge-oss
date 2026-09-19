"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CatalogId } from "@simforge-oss/asset-catalog";
import { LaneIndex, type ScenarioMapEntry } from "@simforge-oss/editor";
import { loadEngine } from "@simforge-oss/engine/browser";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";
import { MapLoadDebugPanel } from "@simforge-oss/studio-ui/scenario/scene/MapLoadDebugPanel";
import { RENDERING_PREFERENCE_CHANGE_EVENT } from "@simforge-oss/studio-ui/components/rendering-preference";
import { defaultAuthoringQuality } from "@simforge-oss/studio-ui/scenario/editor/authoring-quality";
import { studioHost } from "@/app/lib/host";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { DriveSession } from "@/app/dashboard/map-assets/drive/DriveSession";

/** The car the audio graph falls back to when the role names no catalog model. */
const DEFAULT_VEHICLE = "vehicle.sedan" as CatalogId;

/**
 * Driving one scenario's actor, and keeping the drive.
 *
 * Everything the session needs that only the browser can supply loads here: the
 * installed map entry and its lane topology. The recorded clip goes straight
 * into this document — the variation was created for exactly this drive — and
 * the drive leaves for the scenario list once it is saved.
 */
export function DriverInTheLoopDrive({
  content,
  datasetId,
  documentId,
  draftVersion,
  mapVersionId,
  mapSourceMapId,
  roleId,
  title,
}: {
  content: ScenarioTemplateV2;
  datasetId: string;
  documentId: string;
  draftVersion: number;
  mapVersionId: string;
  mapSourceMapId?: string | null;
  roleId: string;
  title: string;
}) {
  const router = useRouter();
  const [resources, setResources] = useState<{
    mapVersionId: string;
    map: ScenarioMapEntry;
    laneIndex: LaneIndex;
  } | null>(null);
  const completedResourcesRef = useRef<typeof resources>(null);
  const [error, setError] = useState<{ mapVersionId: string; message: string; cause: unknown } | null>(null);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>("medium");
  const [installedMaps, setInstalledMaps] = useState<Array<{ sourceMapId: string; mapVersionId: string }> | undefined>();

  // Follows the shared preference so a level picked in the app switcher changes
  // this drive, not the next one.
  useEffect(() => {
    setQuality(defaultAuthoringQuality());
    const onPreference = (event: Event) =>
      setQuality((event as CustomEvent<ScenarioAuthoringQuality>).detail);
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onPreference);
    return () => window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onPreference);
  }, []);

  useEffect(() => {
    // Activity resumes effects without discarding state. Keep the completed
    // pair and its DriveSession/canvas mounted; a loading placeholder here
    // would physically remove the canvas and defeat viewer retention.
    if (completedResourcesRef.current?.mapVersionId === mapVersionId) return;
    const abort = new AbortController();
    completedResourcesRef.current = null;
    setResources(null);
    setError(null);
    void studioHost.artifacts
      .listMaps(abort.signal)
      .then(async (installed) => {
        setInstalledMaps(installed.map(({ sourceMapId, mapVersionId }) => ({ sourceMapId, mapVersionId })));
        const entry = installed.find((candidate) => candidate.mapVersionId === mapVersionId);
        if (!entry) throw new Error("This scenario's map is not installed on this computer.");
        const engine = await loadEngine();
        const index = await LaneIndex.load(entry.topologyUrl, { engine, signal: abort.signal });
        return { mapVersionId, map: entry, laneIndex: index };
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
  }, [mapVersionId]);

  const role = useMemo(
    () => content.roles.find((candidate) => candidate.id === roleId) ?? null,
    [content.roles, roleId],
  );
  const catalogId = (role?.actor.catalogId ?? DEFAULT_VEHICLE) as CatalogId;
  const vehicleLabel = role?.label ?? role?.actor.class ?? "Car";

  const leave = useCallback(() => {
    router.push(`/dashboard/scenario?dataset=${encodeURIComponent(datasetId)}`);
  }, [datasetId, router]);

  /**
   * Write the driven template into this scenario.
   *
   * The session applies the clip to its own live document through the editor's
   * `replaceActorMotion`, so the interaction and every motion it displaces are
   * handled exactly as an authored take would be; what arrives here is the
   * finished template, saved in one PATCH.
   */
  const saveClip = useCallback(
    async (template: ScenarioTemplateV2) => {
      await studioHost.projects.saveDocument(
        { id: documentId, draftVersion, title, authoringQualityId: quality },
        template,
      );
    },
    [documentId, draftVersion, quality, title],
  );

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
        scope="pane"
        title="The drive could not start"
        diagnostics={loadingDiagnostics}
      />
    );
  }
  if (!resources || resources.mapVersionId !== mapVersionId) {
    return (
      <CloudLoadingSurface
        detail="Loading the installed map and its lane network."
        scope="pane"
        title="Starting the drive…"
        diagnostics={loadingDiagnostics}
      />
    );
  }
  return (
    <DriveSession
      catalogId={catalogId}
      content={content}
      laneIndex={resources.laneIndex}
      map={resources.map}
      onExit={leave}
      onSaved={leave}
      onSaveClip={saveClip}
      quality={quality}
      roleId={roleId}
      vehicleLabel={vehicleLabel}
    />
  );
}
