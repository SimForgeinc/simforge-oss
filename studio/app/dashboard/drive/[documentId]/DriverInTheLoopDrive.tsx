"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as stylex from "@stylexjs/stylex";
import { toast } from "sonner";
import type { CatalogId } from "@simforge-oss/asset-catalog";
import { LaneIndex, type ScenarioMapEntry } from "@simforge-oss/editor";
import { loadEngine } from "@simforge-oss/engine/browser";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { resolveScenarioMap } from "@simforge-oss/studio-host";
import { mapsIncludingPinnedVersion } from "@simforge-oss/studio-ui/scenario/scene/pinned-map";
import type { CityViewer } from "@simforge-oss/viewer";
import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";
import { MapLoadDebugPanel } from "@simforge-oss/studio-ui/scenario/scene/MapLoadDebugPanel";
import { DEFAULT_RENDERING_PREFERENCE, renderingPreferenceQuality, useRenderingPreference } from "@simforge-oss/studio-ui/components/rendering-preference";
import type {
  ScenarioWorldState,
  ScenarioWorldTarget,
} from "@simforge-oss/studio-ui/scenario/scene/ScenarioWorldHost";
import {
  EMPTY_WORLD_STATE,
  ScenarioWorldSurface,
} from "@simforge-oss/studio-ui/scenario/scene/ScenarioWorldProvider";
import { studioHost } from "@/app/lib/host";
import { DriveSession } from "@/app/dashboard/map-assets/drive/DriveSession";
import { driveFrame } from "@/app/dashboard/map-assets/drive/drive-session.stylex";

/** The car the audio graph falls back to when the role names no catalog model. */
const DEFAULT_VEHICLE = "vehicle.sedan" as CatalogId;

/** A drive route draws its own car; the world's placed-actor renderer is not its concern. */
function ignoreActorRenderer(): void {}

/**
 * Driving one scenario's actor, and keeping the drive.
 *
 * The drive plays on the dashboard's shared world, so the map the editor was
 * just showing carries on without a reload. Everything else the session needs
 * that only the browser can supply loads here: the installed map entry and its
 * lane topology. The recorded clip goes straight into this document — the
 * variation was created for exactly this drive — and the drive leaves for the
 * scenario list once it is saved.
 */
export function DriverInTheLoopDrive({
  content,
  datasetId,
  documentId,
  draftVersion,
  mapVersionId,
  mapSourceMapId,
  mapXodrSha256,
  roleId,
  title,
}: {
  content: ScenarioTemplateV2;
  datasetId: string;
  documentId: string;
  draftVersion: number;
  mapVersionId: string;
  mapSourceMapId?: string | null;
  mapXodrSha256?: string | null;
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
  const [installedMaps, setInstalledMaps] = useState<Array<{ sourceMapId: string; mapVersionId: string }> | undefined>();
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [worldState, setWorldState] = useState<ScenarioWorldState>(EMPTY_WORLD_STATE);
  // The level picked in the app switcher applies to this drive, exactly as it
  // does to the world it plays on.
  const quality = renderingPreferenceQuality(useRenderingPreference() ?? DEFAULT_RENDERING_PREFERENCE);

  useEffect(() => {
    // Activity resumes effects without discarding state. Keep the completed
    // resources and the session mounted; a loading placeholder here would
    // release the world's lease and restart the drive.
    if (completedResourcesRef.current?.mapVersionId === mapVersionId) return;
    const abort = new AbortController();
    completedResourcesRef.current = null;
    setResources(null);
    setError(null);
    void studioHost.artifacts
      .listMaps(abort.signal)
      .then(async (installed) => {
        setInstalledMaps(installed.map(({ sourceMapId, mapVersionId }) => ({ sourceMapId, mapVersionId })));
        // A document pinned to a superseded map version drives on exactly that version.
        const withPin = await mapsIncludingPinnedVersion(studioHost, installed, { id: documentId, mapVersionId }, abort.signal);
        const entry = resolveScenarioMap({ mapVersionId, mapSourceMapId, mapXodrSha256 }, withPin);
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
  }, [mapVersionId, mapSourceMapId, mapXodrSha256]);

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

  const map = resources?.mapVersionId === mapVersionId ? resources.map : null;
  const target = useMemo<ScenarioWorldTarget | null>(() => map && ({
    mapId: map.sourceMapId,
    installedMaps,
    mapVersionId: map.mapVersionId,
    manifestUrl: map.browserManifestUrl,
    label: map.label,
    locality: map.locality,
  }), [installedMaps, map]);

  if (error?.mapVersionId === mapVersionId) {
    return (
      <CloudLoadingSurface
        detail={error.message}
        role="alert"
        scope="pane"
        title="The drive could not start"
        diagnostics={<MapLoadDebugPanel source={{
          getViewer: () => null,
          mapVersionId,
          mapId: mapSourceMapId,
          installedMaps,
          requestedTier: quality,
          phase: "error",
          readinessAnnounced: false,
          error: error.cause,
        }} />}
      />
    );
  }
  const mapLoaded = worldState.loadedMapVersionId === mapVersionId;
  return (
    <div {...stylex.props(driveFrame.route)}>
      <ScenarioWorldSurface
        className={stylex.props(driveFrame.world).className}
        interactive={false}
        onActorRendererChange={ignoreActorRenderer}
        onStateChange={setWorldState}
        onViewerChange={setViewer}
        pendingTarget={target === null}
        target={target}
      />
      {map && resources ? (
        <DriveSession
          catalogId={catalogId}
          content={content}
          laneIndex={resources.laneIndex}
          map={map}
          mapLoaded={mapLoaded}
          onExit={leave}
          onSaved={leave}
          onSaveClip={saveClip}
          quality={quality}
          roleId={roleId}
          vehicleLabel={vehicleLabel}
          viewer={viewer}
        />
      ) : null}
    </div>
  );
}
