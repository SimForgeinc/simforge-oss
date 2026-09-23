"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ScenarioMapEntry } from "@simforge-oss/editor";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { resolveScenarioMap } from "@simforge-oss/studio-host";
import { studioHost } from "@/app/lib/host";
import { DriveSession } from "@/app/dashboard/map-assets/drive/DriveSession";

/** Run the selected authored role through the bench. Recorded policy output never edits its source document. */
export function DriverInTheLoopDrive({ content, datasetId, mapVersionId, mapSourceMapId, mapXodrSha256, roleId, title }: {
  content: ScenarioTemplateV2;
  datasetId: string;
  mapVersionId: string;
  mapSourceMapId?: string | null;
  mapXodrSha256?: string | null;
  roleId: string;
  title: string;
}) {
  const router = useRouter();
  const [map, setMap] = useState<ScenarioMapEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setMap(null); setError(null);
    void studioHost.artifacts.listMaps(abort.signal).then((installed) => {
      if (!abort.signal.aborted) setMap(resolveScenarioMap({ mapVersionId, mapSourceMapId, mapXodrSha256 }, installed));
    }).catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => abort.abort();
  }, [mapVersionId, mapSourceMapId, mapXodrSha256]);
  if (error) return <p role="alert">Cannot resolve scenario map: {error}</p>;
  if (!map) return <p>Resolving authored map…</p>;
  return <DriveSession content={content} map={map} roleId={roleId} label={title} onExit={() => router.push(`/dashboard/scenario?dataset=${encodeURIComponent(datasetId)}`)} />;
}
