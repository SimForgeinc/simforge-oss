"use client";

import { CheckCircle2, FileUp, MapPin } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";
import {
  SERVER_GENERATED_CLOSURE_PATHS,
  type CreateMapUploadInput,
  type CreateMapUploadResult,
  type PublishedMapSummary,
} from "@/app/lib/map-ingest/contracts";
import type { ImportedMap } from "@/app/lib/map-ingest/map-import";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { dialog } from "./asset-dialogs.stylex";

/**
 * Where the map upload is in its lifecycle. The dialog owns the shared progress
 * bar, error line and footer, so it needs one value — not five booleans — to
 * decide whether closing is safe and what the primary action means.
 */
export type MapUploadPhase = "empty" | "parsing" | "ready" | "uploading" | "generating" | "published";

/**
 * Structural type of the dialog's `uploadBlob`. Declared here rather than
 * imported so the panel does not import the component that renders it.
 */
type BlobUploader = (
  target: { url: string; headers: Record<string, string> },
  blob: Blob,
  onProgress: (fraction: number) => void,
) => Promise<void>;

type ResponseErrorReader = (response: Response, fallback: string) => Promise<string>;

/**
 * What each server-generated closure member is, in the user's terms. Keyed on the
 * frozen contract list so adding a member to the closure fails the build here
 * instead of quietly shipping an unexplained artifact.
 */
const GENERATED_ARTIFACT_LABELS: Record<(typeof SERVER_GENERATED_CLOSURE_PATHS)[number], string> = {
  "3d/manifest.json": "City manifest — scene bounds, triangle totals and the static layer index",
  "3d/semantics.json": "Static semantics — per-node classification for every layer",
  "3d/variants/manifest.json":
    "Static collision — building and barrier colliders the browser simulation needs",
  "topology-index.json.gz": "Road topology — lanes, junctions and turn gates",
  "lane-polygons.geojson.gz": "Lane polygons — the drivable surface footprint",
  "signals.geojson.gz": "Traffic signals — signal heads and the lanes they control",
  "derived/topology-derived.json.gz": "Derived topology — the editor's routing and search structures",
  "derived/locations.json.gz": "Named locations — the junctions, crosswalks and streets map search resolves",
  "derived/roadway-consistency.json.gz": "Roadway consistency — the road geometry checked against the topology",
};

function formatBytes(bytes: number) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div {...stylex.props(dialog.stat)}>
      <p {...stylex.props(dialog.statLabel)}>{label}</p>
      <p {...stylex.props(dialog.statValue)}>{value}</p>
    </div>
  );
}

export function MapUploadPanel({
  formId,
  uploadBlob,
  responseError,
  onPhaseChange,
  onStatusChange,
  onProgressChange,
  onErrorChange,
  onPublished,
}: {
  /** The dialog's shared form id, so its footer button submits this form. */
  formId: string;
  uploadBlob: BlobUploader;
  responseError: ResponseErrorReader;
  onPhaseChange: (phase: MapUploadPhase) => void;
  onStatusChange: (status: string) => void;
  onProgressChange: (progress: number) => void;
  onErrorChange: (error: string | null) => void;
  onPublished: (summary: PublishedMapSummary) => void;
}) {
  const carlaFieldId = useId();
  const carlaHelpId = useId();
  const [map, setMap] = useState<ImportedMap | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [locality, setLocality] = useState("");
  const [carlaMapName, setCarlaMapName] = useState("");
  const [phase, setPhase] = useState<MapUploadPhase>("empty");
  const [published, setPublished] = useState<PublishedMapSummary | null>(null);

  useEffect(() => () => {
    if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
  }, [thumbnailUrl]);

  const enterPhase = (next: MapUploadPhase) => {
    setPhase(next);
    onPhaseChange(next);
  };

  // A second selection landing mid-flight would race the first on `map` and on the
  // phase. Parsing is abandonable by closing the dialog, but not by overlapping it.
  const busy = phase === "parsing" || phase === "uploading" || phase === "generating";

  const chooseFiles = (selected: File[]) => {
    if (selected.length === 0 || busy) return;
    void importFiles(selected);
  };

  const importFiles = async (selected: File[]) => {
    enterPhase("parsing");
    onErrorChange(null);
    onStatusChange("Parsing OpenDRIVE and layer geometry…");
    onProgressChange(8);
    try {
      // Deliberately dynamic, exactly as the model path is: a static import would
      // pull three.js and the GLB parser into the dashboard's first-load bundle for
      // every visitor, when only the few who upload a map ever need them.
      const { importMapFiles } = await import("@/app/lib/map-ingest/map-import");
      const imported = await importMapFiles(selected);
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      setMap(imported);
      setThumbnailUrl(URL.createObjectURL(imported.thumbnailBlob));
      // The OpenDRIVE header names the map. Carrying the previous label over would
      // publish the last map's name onto a different road network.
      setLabel(imported.mapName);
      enterPhase("ready");
      onStatusChange("Map ready to publish");
      onProgressChange(40);
    } catch (reason) {
      setMap(null);
      enterPhase("empty");
      onStatusChange("");
      onProgressChange(0);
      onErrorChange(reason instanceof Error ? reason.message : "The map files could not be read.");
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!map || phase !== "ready") return;
    enterPhase("uploading");
    onErrorChange(null);
    onProgressChange(44);
    onStatusChange("Creating map upload…");
    try {
      const input: CreateMapUploadInput = {
        label: label.trim(),
        locality: locality.trim(),
        carlaMapName: carlaMapName.trim() || null,
        xodr: { sha256: map.xodr.sha256, byteLength: map.xodr.blob.size },
        thumbnail: { sha256: map.thumbnailSha256, byteLength: map.thumbnailBlob.size },
        layers: map.layers.map((layer) => ({
          layerId: layer.layerId,
          fileName: layer.fileName,
          sha256: layer.sha256,
          byteLength: layer.blob.size,
          triangleCount: layer.triangleCount,
        })),
        preflight: map.preflight,
      };
      const createResponse = await fetch("/api/map-ingest/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!createResponse.ok) {
        throw new Error(await responseError(createResponse, "The map upload could not be created."));
      }
      const created = (await createResponse.json()) as CreateMapUploadResult;

      // The draft names its members by canonical path, and every one of them must
      // resolve to bytes this tab actually holds. A path we cannot resolve is a
      // contract break, not something to skip quietly.
      const bytesByPath = new Map<string, Blob>([
        ["map.xodr", map.xodr.blob],
        ["thumbnail.webp", map.thumbnailBlob],
        ...map.layers.map((layer): [string, Blob] => [`3d/${layer.layerId}.glb`, layer.blob]),
      ]);
      const transfers: Array<{ url: string; headers: Record<string, string>; blob: Blob }> = [];
      let storedAlready = 0;
      for (const target of created.uploads) {
        const blob = bytesByPath.get(target.path);
        if (!blob) {
          throw new Error(`The server asked for ${target.path}, which this upload does not contain.`);
        }
        // A null URL means the bucket already holds these exact content-addressed bytes.
        if (target.url === null) {
          storedAlready += 1;
          continue;
        }
        transfers.push({ url: target.url, headers: target.headers, blob });
      }

      if (transfers.length === 0) {
        onProgressChange(84);
        onStatusChange(`All ${storedAlready} files were already stored`);
      } else {
        onStatusChange(
          storedAlready > 0
            ? `Uploading ${transfers.length} files · ${storedAlready} already stored`
            : `Uploading ${transfers.length} files…`,
        );
        const totalBytes = transfers.reduce((total, target) => total + target.blob.size, 0);
        const loadedBytes = new Array<number>(transfers.length).fill(0);
        const updateProgress = () => {
          let loaded = 0;
          for (const value of loadedBytes) loaded += value;
          onProgressChange(44 + Math.round((loaded / totalBytes) * 40));
        };
        await Promise.all(
          transfers.map((target, index) =>
            uploadBlob({ url: target.url, headers: target.headers }, target.blob, (fraction) => {
              loadedBytes[index] = fraction * target.blob.size;
              updateProgress();
            }),
          ),
        );
      }

      enterPhase("generating");
      onProgressChange(86);
      onStatusChange("Publishing — generating derived map artifacts…");
      const publishResponse = await fetch(
        `/api/map-ingest/uploads/${encodeURIComponent(created.draftId)}/publish`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      if (!publishResponse.ok) {
        throw new Error(await responseError(publishResponse, "The map could not be published."));
      }
      const { map: summary } = (await publishResponse.json()) as { map: PublishedMapSummary };
      setPublished(summary);
      enterPhase("published");
      onProgressChange(100);
      onStatusChange("Map version published");
      onPublished(summary);
    } catch (reason) {
      // Back to `ready`, not a dead end: the bytes are unchanged and content
      // addressing makes a second attempt cheap.
      enterPhase("ready");
      onStatusChange("Publish failed");
      onErrorChange(reason instanceof Error ? reason.message : "The map could not be published.");
    }
  };

  if (published) {
    return (
      <div {...stylex.props(dialog.panel)}>
        <div {...stylex.props(dialog.cardSuccess)}>
          <p {...stylex.props(dialog.titleText)}><CheckCircle2 {...stylex.props(dialog.iconSm)} />{published.label} is published and available in the scenario editor</p>
          <p {...stylex.props(dialog.uploadLocality)}><MapPin {...stylex.props(dialog.iconSm)} />{published.locality} · roadway consistency: {published.generated.roadwayConsistencyVerdict}</p>
        </div>

        <div {...stylex.props(dialog.grid2)}>
          <StatTile label="Lanes" value={published.generated.laneCount.toLocaleString()} />
          <StatTile label="Junctions" value={published.generated.junctionCount.toLocaleString()} />
          <StatTile label="Locations" value={published.generated.locationCount.toLocaleString()} />
          <StatTile label="Triangles" value={published.generated.triangleCount.toLocaleString()} />
        </div>
        <div {...stylex.props(dialog.grid2)}>
          <StatTile label="Closure objects" value={`${published.objectCount.toLocaleString()} files`} />
          <StatTile label="Closure size" value={formatBytes(published.byteLength)} />
        </div>

        {published.browserOnly ? (
          <div {...stylex.props(dialog.cardWarning)}>
            <p {...stylex.props(dialog.uploadWarnTitle)}>Browser-only map version</p>
            <p {...stylex.props(dialog.uploadWarnNote)}>
              No cooked CARLA map is bound to this version, so CARLA renders will refuse it. Scenarios author
              and render in the browser. To enable local CARLA renders, cook a CARLA map, then publish again
              with its name in the CARLA map name field.
            </p>
          </div>
        ) : null}

        <dl {...stylex.props(dialog.dlXs)}>
          <div>
            <dt {...stylex.props(dialog.dlLabel)}>Map version</dt>
            <dd {...stylex.props(dialog.uploadMono)}>{published.mapVersionId}</dd>
          </div>
          <div>
            <dt {...stylex.props(dialog.dlLabel)}>Closure digest</dt>
            <dd {...stylex.props(dialog.uploadMono)}>{published.closureSha256}</dd>
          </div>
        </dl>
      </div>
    );
  }

  const totalLayerBytes = map?.layers.reduce((total, layer) => total + layer.blob.size, 0) ?? 0;

  return (
    <form id={formId} onSubmit={submit} {...stylex.props(dialog.form)}>
      <label onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFiles(Array.from(event.dataTransfer.files)); }} {...stylex.props(dialog.drop, dialog.dropPointer)}>
        <input type="file" multiple disabled={busy} {...stylex.props(dialog.srOnly)} accept=".xodr,.glb" onChange={(event) => chooseFiles(Array.from(event.target.files ?? []))} />
        <FileUp {...stylex.props(dialog.iconAccent)} aria-hidden="true" />
        <span {...stylex.props(dialog.uploadDropLabel)}>Drop map.xodr and one GLB per layer here</span>
        <span {...stylex.props(dialog.dropHint)}>road.glb is required. Add sidewalk, building, vegetation, terrain, furniture, pole, signage or water as separate GLBs — the file name is the layer id.</span>
      </label>
      {map && thumbnailUrl ? (
        <>
          <div {...stylex.props(dialog.preflightGrid)}>
            <div>
              <img src={thumbnailUrl} alt="Rendered preview of the uploaded map" {...stylex.props(dialog.preview)} />
              <p {...stylex.props(dialog.mutedTextMt2)}>{map.totalTriangles.toLocaleString()} triangles · {formatBytes(totalLayerBytes)} of geometry</p>
            </div>
            <div {...stylex.props(dialog.stack)}>
              <div><p {...stylex.props(dialog.statLabel)}>OpenDRIVE map name</p><p {...stylex.props(dialog.statText)}>{map.mapName}</p></div>
              <div {...stylex.props(dialog.grid2)}>
                <StatTile label="Lanes" value={map.preflight.laneCount.toLocaleString()} />
                <StatTile label="Drivable lanes" value={map.preflight.drivableLaneCount.toLocaleString()} />
                <StatTile label="Junctions" value={map.preflight.junctionCount.toLocaleString()} />
                <StatTile label="Georeferenced" value={map.preflight.georeferenced ? "Yes" : "Local coordinates only"} />
              </div>
              <div><p {...stylex.props(dialog.statLabel)}>Plan-view geometry</p><p {...stylex.props(dialog.statText)}>{map.preflight.geometryKinds.join(", ")}</p></div>
            </div>
          </div>
          <div><p {...stylex.props(dialog.statLabel)}>{map.layers.length === 1 ? "1 layer" : `${map.layers.length} layers`}</p><ul {...stylex.props(dialog.layerList)}>{map.layers.map((layer) => <li key={layer.layerId} {...stylex.props(dialog.layerRow)}><span {...stylex.props(dialog.layerId)}>{layer.layerId}</span><span {...stylex.props(dialog.layerFile)}>{layer.fileName}</span><span {...stylex.props(dialog.layerMeta)}>{layer.triangleCount.toLocaleString()} tris · {formatBytes(layer.blob.size)}</span></li>)}</ul></div>
        </>
      ) : null}

      <div {...stylex.props(dialog.grid)}>
        <label {...stylex.props(dialog.fieldLabel)}>Label<Input required minLength={3} maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Downtown New Haven" xstyle={dialog.fieldControl} /></label>
        <label {...stylex.props(dialog.fieldLabel)}>Locality<Input required minLength={2} maxLength={120} value={locality} onChange={(event) => setLocality(event.target.value)} placeholder="New Haven, Connecticut" xstyle={dialog.fieldControl} /></label>
        <div {...stylex.props(dialog.span2)}>
          <label htmlFor={carlaFieldId} {...stylex.props(dialog.fieldLabel)}>CARLA map name, optional</label>
          <Input id={carlaFieldId} aria-describedby={carlaHelpId} maxLength={120} value={carlaMapName} onChange={(event) => setCarlaMapName(event.target.value)} placeholder="Town10HD_Opt" xstyle={dialog.fieldControl} />
          <p id={carlaHelpId} {...stylex.props(dialog.helpText)}>Fill this in only when a cooked CARLA map of the same road network already exists. Leave it empty and the map version is browser-only: you can author and render scenarios in the browser, but local CARLA renders are not available for it.</p>
        </div>
      </div>

      {phase === "generating" ? (
        // Not a live region: the dialog's status line already announces the phase, and
        // announcing eight artifact names on top of it is noise, not information.
        <div {...stylex.props(dialog.generateCard)}>
          <p {...stylex.props(dialog.generateHeading)}>Generating on the server</p>
          <p {...stylex.props(dialog.generateText)}>Your files are stored. The publisher is now building the {SERVER_GENERATED_CLOSURE_PATHS.length} derived artifacts the editor loads, and binding them into one immutable map version. This usually takes up to a minute — keep this dialog open.</p>
          <ul {...stylex.props(dialog.artifactList)}>
            {SERVER_GENERATED_CLOSURE_PATHS.map((path) => (
              <li key={path} {...stylex.props(dialog.artifactItem)}>
                <span aria-hidden="true" {...stylex.props(dialog.artifactDot)} />
                <span><span {...stylex.props(dialog.cellStrong)}>{path}</span> — {GENERATED_ARTIFACT_LABELS[path]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}
