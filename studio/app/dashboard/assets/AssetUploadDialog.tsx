"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Boxes, FileUp, Map as MapIcon, Upload, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState, useMemo} from "react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { SelectMenuField } from "@simforge-oss/studio-ui/components/ui/select-menu";
import { Textarea } from "@simforge-oss/studio-ui/components/ui/textarea";
import {
  gallerySuggestedScale,
  galleryTypicalSizeFor,
  GALLERY_ARCHETYPE_ACTOR_CLASSES,
  type GalleryMotionArchetype,
  type GalleryActorClass,
  type GalleryAssetSummary,
  type GalleryDimensions,
  type GallerySourceFormat,
} from "@simforge-oss/studio-ui/lib/asset-gallery/contracts";
import type { GalleryModelFacing } from "@/app/lib/asset-gallery/model-import";
import type { PublishedMapSummary } from "@/app/lib/map-ingest/contracts";
import { dialog } from "./asset-dialogs.stylex";
import { MapUploadPanel, type MapUploadPhase } from "./MapUploadPanel";

/** Which kind of asset the dialog is publishing. */
export type AssetUploadKind = "model" | "map";
type ImportedModel = {
  glbBlob: Blob;
  glbSha256: string;
  thumbnailBlob: Blob;
  thumbnailSha256: string;
  dims: GalleryDimensions;
  triangleCount: number;
  animated: boolean;
  clips: string[];
  sourceFormat: GallerySourceFormat;
  warnings: string[];
};
type UploadTarget = { url: string; headers: Record<string, string> };

const MOTION_OPTIONS: readonly {
  readonly value: GalleryMotionArchetype;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: "static",
    label: "Static object",
    description: "Never moves. Collides and occludes — barriers, signs, street furniture.",
  },
  {
    value: "ground",
    label: "Moving on the ground",
    description: "Walks or drives on any surface and takes a custom route — pedestrians, animals, robots.",
  },
  {
    value: "flying",
    label: "Flying",
    description: "Holds altitude and takes a custom route — drones and other aerial actors.",
  },
  {
    value: "road_vehicle",
    label: "Road vehicle",
    description: "Anchored to an OpenDRIVE lane like the built-in cars, so it drives the road network.",
  },
];
const GROUND_CLASS_OPTIONS = GALLERY_ARCHETYPE_ACTOR_CLASSES.ground.map((value) => ({
  value,
  label: value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
}));
const MODEL_FORMATS: Record<GallerySourceFormat, true> = {
  glb: true,
  gltf: true,
  fbx: true,
  obj: true,
  stl: true,
  dae: true,
  ply: true,
  usdz: true,
};


function uploadBlob(
  target: UploadTarget,
  blob: Blob,
  onProgress: (fraction: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", target.url);
    for (const [name, value] of Object.entries(target.headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onerror = () => reject(new Error("The storage upload was interrupted."));
    request.onabort = () => reject(new Error("The storage upload was cancelled."));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Storage rejected the upload (${request.status}).`));
    };
    request.send(blob);
  });
}

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } | string; message?: string }
    | null;
  if (typeof body?.error === "string") return body.error;
  return body?.error?.message ?? body?.message ?? fallback;
}

export function AssetUploadDialog({
  open,
  initialKind,
  onOpenChange,
  onUploaded,
  onMapPublished,
}: {
  open: boolean;
  /** Which mode the dialog opens in, so the gallery's active section picks it. */
  initialKind: AssetUploadKind;
  onOpenChange: (open: boolean) => void;
  onUploaded: (asset: GalleryAssetSummary) => void;
  onMapPublished: (summary: PublishedMapSummary) => void;
}) {
  const formId = useId();
  const [kind, setKind] = useState<AssetUploadKind>(initialKind);
  const [mapPhase, setMapPhase] = useState<MapUploadPhase>("empty");
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [model, setModel] = useState<ImportedModel | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // No preselection: the author states how the model moves, because the wrong
  // inherited answer is either an unroutable pedestrian or a drifting barrier.
  const [archetype, setArchetype] = useState<GalleryMotionArchetype | null>(null);
  const [actorClass, setActorClass] = useState<GalleryActorClass | null>(null);
  const [tags, setTags] = useState("");
  const [upAxis, setUpAxis] = useState<"auto" | "y" | "z">("auto");
  const [facing, setFacing] = useState<GalleryModelFacing>("auto");
  const [scale, setScale] = useState("1");
  const [idleClip, setIdleClip] = useState("");
  const [locomotionClip, setLocomotionClip] = useState("");
  const [processing, setProcessing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Picking the archetype also picks its default class, so only the ground
  // archetype — pedestrian vs animal vs robot — needs a second question.
  const selectArchetype = (next: GalleryMotionArchetype) => {
    setArchetype(next);
    setActorClass(GALLERY_ARCHETYPE_ACTOR_CLASSES[next][0]);
  };

  useEffect(() => () => {
    if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
  }, [thumbnailUrl]);

  // One reset point for both modes. Progress, status and the error line describe a
  // single attempt; carrying any of them into the next time the dialog opens would
  // report the previous upload's outcome over the new one.
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      return;
    }
    setMapPhase("empty");
    setStatus("");
    setProgress(0);
    setError(null);
    // The motion answer belongs to one model, never to the next one.
    setArchetype(null);
    setActorClass(null);
  }, [open, initialKind]);

  const processFiles = async (
    selected: File[],
    transform: { upAxis: "auto" | "y" | "z"; scale?: number; facing?: GalleryModelFacing },
  ) => {
    const main = selected.find((candidate) => {
      const extension = candidate.name.split(".").pop()?.toLowerCase() ?? "";
      return extension in MODEL_FORMATS;
    });
    if (!main) {
      setError("Choose a supported 3D model file.");
      return;
    }
    setProcessing(true);
    setError(null);
    setStatus("Parsing and normalising model…");
    setProgress(8);
    try {
      // This event boundary creates the importer chunk; its format branches create one loader chunk each.
      const { importModelFile: runImport } = await import("@/app/lib/asset-gallery/model-import");
      const imported = await runImport(main, {
        upAxis: transform.upAxis,
        facing: transform.facing ?? "auto",
        scale: transform.scale,
        relatedFiles: selected.filter((file) => file !== main),
      });
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      setModel(imported);
      setThumbnailUrl(URL.createObjectURL(imported.thumbnailBlob));
      // Each imported file names its own asset. Carrying the previous title over
      // silently republishes the last name onto a different model.
      setTitle(main.name.replace(/\.[^.]+$/, ""));
      setIdleClip(imported.clips[0] ?? "");
      setLocomotionClip(imported.clips[1] ?? imported.clips[0] ?? "");
      setStatus("Model ready to upload");
      setProgress(45);
    } catch (reason) {
      setModel(null);
      setStatus("");
      setProgress(0);
      setError(reason instanceof Error ? reason.message : "The model could not be imported.");
    } finally {
      setProcessing(false);
    }
  };

  const chooseFiles = (selected: File[]) => {
    if (selected.length === 0) return;
    setFiles(selected);
    setUpAxis("auto");
    const main = selected.find((candidate) => {
      const extension = candidate.name.split(".").pop()?.toLowerCase() ?? "";
      return extension in MODEL_FORMATS;
    });
    const guessedScale = main?.name.toLowerCase().endsWith(".fbx") ? 0.01 : 1;
    setScale(String(guessedScale));
    setFacing("auto");
    void processFiles(selected, { upAxis: "auto", scale: guessedScale, facing: "auto" });
  };

  const reprocess = () => {
    const numericScale = Number(scale);
    if (!Number.isFinite(numericScale) || numericScale <= 0) {
      setError("Scale must be a positive number.");
      return;
    }
    void processFiles(files, { upAxis, scale: numericScale, facing });
  };

  /**
   * The scale that would make this model its class's typical real size.
   *
   * Null until the author has answered the motion question, because that answer
   * is what names the reference: the same 190-unit box is a car or a bollard
   * depending on it, and `static_object` has no typical size at all.
   */
  const autoSize = useMemo(() => {
    if (!model || !actorClass) return null;
    const typical = galleryTypicalSizeFor(actorClass);
    const applied = Number(scale);
    const suggested = gallerySuggestedScale(actorClass, model.dims, applied);
    if (!typical || suggested === null) return null;
    return {
      scale: suggested,
      metres: typical.metres,
      example: typical.example,
      axisLabel: typical.axis === "h" ? "tall" : "long",
    };
  }, [model, actorClass, scale]);

  const applyAutoSize = (nextScale: number) => {
    // Round to a stable, editable number: the author sees what was applied and
    // can nudge it, rather than a 17-digit float they cannot reason about.
    const rounded = Number(nextScale.toPrecision(4));
    setScale(String(rounded));
    void processFiles(files, { upAxis, scale: rounded, facing });
  };

  /**
   * Turn the model 180°.
   *
   * "Auto" resolves to a concrete nose first, otherwise the first flip after an
   * auto-detect would look like it did nothing: the author sees which way it is
   * pointing now and flips from there.
   */
  const flipFacing = () => {
    const resolved: GalleryModelFacing = facing === "auto"
      ? (model && model.dims.w > model.dims.l ? "+z" : "+x")
      : facing;
    const opposite: Record<Exclude<GalleryModelFacing, "auto">, GalleryModelFacing> = {
      "+x": "-x",
      "-x": "+x",
      "+z": "-z",
      "-z": "+z",
    };
    const next = opposite[resolved as Exclude<GalleryModelFacing, "auto">];
    setFacing(next);
    void processFiles(files, { upAxis, scale: Number(scale), facing: next });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!model || uploading) return;
    if (!actorClass) {
      setError("Choose how this model moves before publishing it.");
      return;
    }
    setUploading(true);
    setError(null);
    setProgress(48);
    setStatus("Creating upload…");
    try {
      const normalizedTags = tags
        .split(",")
        .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
        .filter(Boolean);
      const createResponse = await fetch("/api/asset-gallery/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description: description.trim() || undefined,
          actorClass,
          tags: [...new Set(normalizedTags)],
          sourceFormat: model.sourceFormat,
          glb: { sha256: model.glbSha256, byteLength: model.glbBlob.size },
          thumbnail: { sha256: model.thumbnailSha256, byteLength: model.thumbnailBlob.size },
          dims: model.dims,
          triangleCount: model.triangleCount,
          animated: model.animated,
          clips: model.clips,
          idleClip: idleClip || undefined,
          locomotionClip: locomotionClip || undefined,
        }),
      });
      if (!createResponse.ok) {
        throw new Error(await responseError(createResponse, "The upload could not be created."));
      }
      const created = (await createResponse.json()) as {
        versionId: string;
        glbUpload: UploadTarget;
        thumbnailUpload: UploadTarget;
      };

      setStatus("Uploading converted model and thumbnail…");
      let glbProgress = 0;
      let thumbnailProgress = 0;
      const updateProgress = () => setProgress(52 + Math.round((glbProgress * 0.85 + thumbnailProgress * 0.15) * 38));
      await Promise.all([
        uploadBlob(created.glbUpload, model.glbBlob, (value) => {
          glbProgress = value;
          updateProgress();
        }),
        uploadBlob(created.thumbnailUpload, model.thumbnailBlob, (value) => {
          thumbnailProgress = value;
          updateProgress();
        }),
      ]);

      setProgress(94);
      setStatus("Verifying uploaded files…");
      const completeResponse = await fetch(
        `/api/asset-gallery/uploads/${created.versionId}/complete`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      if (!completeResponse.ok) {
        throw new Error(await responseError(completeResponse, "The uploaded files could not be verified."));
      }
      const completed = (await completeResponse.json()) as { asset: GalleryAssetSummary };
      setProgress(100);
      setStatus("Published to the gallery");
      onUploaded(completed.asset);
      onOpenChange(false);
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      setFiles([]);
      setModel(null);
      setThumbnailUrl(null);
      setTitle("");
      setDescription("");
      setTags("");
      setIdleClip("");
      setLocomotionClip("");
      setStatus("");
      setProgress(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The asset could not be uploaded.");
      setStatus("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  // Both modes drive the same bar, so "is a transfer in flight" is one question.
  const busy = uploading || mapPhase === "uploading" || mapPhase === "generating";
  const selectKind = (next: AssetUploadKind) => {
    if (next === kind) return;
    setKind(next);
    setMapPhase("empty");
    setStatus("");
    setProgress(0);
    setError(null);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen); }}>
      <Dialog.Portal>
        <Dialog.Overlay {...stylex.props(dialog.overlay)} />
        <Dialog.Content {...stylex.props(dialog.content)}>
          <Dialog.Title {...stylex.props(dialog.title)}>
            {kind === "model" ? "Upload 3D asset" : "Upload map"}
          </Dialog.Title>
          <Dialog.Description {...stylex.props(dialog.description)}>
            {kind === "model"
              ? "Models are converted to GLB and thumbnailed entirely in your browser."
              : "The road network and layer geometry are read in your browser. Publishing generates the manifest, semantics and derived artifacts on the server."}
          </Dialog.Description>
          <Dialog.Close asChild>
            <button type="button" aria-label="Close upload dialog" disabled={busy} {...stylex.props(dialog.close)}>
              <X {...stylex.props(dialog.iconSm)} />
            </button>
          </Dialog.Close>

          <div {...stylex.props(dialog.tabGroup)} role="group" aria-label="Asset kind">
            <button
              type="button"
              aria-pressed={kind === "model"}
              disabled={busy}
              onClick={() => selectKind("model")}
              {...stylex.props(dialog.tab, kind === "model" ? dialog.tabActive : null)}
            >
              <Boxes {...stylex.props(dialog.iconSm)} aria-hidden="true" />3D model
            </button>
            <button
              type="button"
              aria-pressed={kind === "map"}
              disabled={busy}
              onClick={() => selectKind("map")}
              {...stylex.props(dialog.tab, kind === "map" ? dialog.tabActive : null)}
            >
              <MapIcon {...stylex.props(dialog.iconSm)} aria-hidden="true" />Map
            </button>
          </div>

          {kind === "model" ? (
            <form id={formId} onSubmit={submit} {...stylex.props(dialog.form)}>
              <input
                ref={inputRef}
                type="file"
                multiple
                {...stylex.props(dialog.srOnly)}
                accept=".glb,.gltf,.fbx,.obj,.mtl,.stl,.dae,.ply,.usdz,image/*"
                onChange={(event) => chooseFiles(Array.from(event.target.files ?? []))}
              />
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  chooseFiles(Array.from(event.dataTransfer.files));
                }}
                {...stylex.props(dialog.drop)}
              >
                <FileUp {...stylex.props(dialog.iconAccent)} />
                <span {...stylex.props(dialog.uploadDropLabel)}>Drop a model and its texture files here</span>
                <span {...stylex.props(dialog.subText)}>GLB, GLTF, FBX, OBJ, STL, DAE, PLY or USDZ</span>
              </button>

              {model && thumbnailUrl ? (
                <div {...stylex.props(dialog.uploadPreviewGrid)}>
                  <div>
                    {/* eslint-disable-next-line @next/next/no-img-element -- client-generated blob: URL for the pre-upload preview */}
                    <img src={thumbnailUrl} alt="Generated model thumbnail" {...stylex.props(dialog.uploadImage)} />
                    <p {...stylex.props(dialog.uploadMeta)}>
                      {model.dims.l.toFixed(2)} × {model.dims.w.toFixed(2)} × {model.dims.h.toFixed(2)} m · {model.triangleCount.toLocaleString()} triangles
                    </p>
                  </div>
                  <div {...stylex.props(dialog.uploadControls)}>
                    <div {...stylex.props(dialog.uploadGrid2)}>
                      <SelectMenuField
                        label="Up axis"
                        value={upAxis}
                        onChange={(value) => setUpAxis(value as "auto" | "y" | "z")}
                        options={[{ value: "auto", label: "Auto detect" }, { value: "y", label: "Y up" }, { value: "z", label: "Z up" }]}
                        labelClassName="mb-1 text-xs text-white/45"
                      />
                      <label {...stylex.props(dialog.uploadLabel)}>
                        Scale to metres
                        <Input value={scale} onChange={(event) => setScale(event.target.value)} inputMode="decimal" {...stylex.props(dialog.uploadField)} />
                      </label>
                    </div>
                    {/* Editor-core drives every actor nose-first along +X, so a model
                        authored facing the other way runs its routes backwards. */}
                    <div {...stylex.props(dialog.uploadGrid2)}>
                      <SelectMenuField
                        label="Facing"
                        value={facing}
                        onChange={(value) => setFacing(value as GalleryModelFacing)}
                        options={[
                          { value: "auto", label: "Auto detect" },
                          { value: "+x", label: "Nose +X" },
                          { value: "-x", label: "Nose −X" },
                          { value: "+z", label: "Nose +Z" },
                          { value: "-z", label: "Nose −Z" },
                        ]}
                        labelClassName="mb-1 text-xs text-white/45"
                      />
                      <div {...stylex.props(dialog.uploadRow)}>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={processing}
                          onClick={flipFacing}
                          {...stylex.props(dialog.uploadFullButton)}
                          title="Turn the model 180° — use it when the thumbnail faces the wrong way"
                        >
                          Flip 180°
                        </Button>
                      </div>
                    </div>
                    <div {...stylex.props(dialog.uploadRow)}>
                      <Button type="button" size="sm" variant="outline" disabled={processing} onClick={reprocess} {...stylex.props(dialog.uploadTransparent)}>
                        {processing ? "Reprocessing…" : "Apply correction"}
                      </Button>
                      {/* A file states no unit, but an author knows what the thing is:
                          picking the class derives the scale from a real example of it. */}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={processing || autoSize === null}
                        onClick={() => autoSize && applyAutoSize(autoSize.scale)}
                        {...stylex.props(dialog.autoSize)}
                        title={
                          autoSize
                            ? `Scale so it is ${autoSize.metres} m ${autoSize.axisLabel}, like ${autoSize.example}`
                            : "Choose how this model moves first"
                        }
                      >
                        {autoSize ? `Auto-size to ${autoSize.metres} m ${autoSize.axisLabel}` : "Auto-size"}
                      </Button>
                      {autoSize ? (
                        <span {...stylex.props(dialog.warningText)}>{`typical for ${autoSize.example}`}</span>
                      ) : (
                        <span {...stylex.props(dialog.warningText)}>pick a motion answer to enable</span>
                      )}
                    </div>
                    {model.warnings.map((warning) => <p key={warning} {...stylex.props(dialog.warningText)}>{warning}</p>)}
                    <div>
                      <p {...stylex.props(dialog.clipsTitle)}>Detected clips</p>
                      <p {...stylex.props(dialog.clipsText)}>{model.clips.length > 0 ? model.clips.join(", ") : "No animation clips"}</p>
                    </div>
                  </div>
                </div>
              ) : null}

              <div {...stylex.props(dialog.uploadGrid)}>
                <label {...stylex.props(dialog.uploadLabel)}>Title<Input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} {...stylex.props(dialog.uploadField)} /></label>
                {archetype === "ground" ? (
                  <SelectMenuField
                    label="Ground actor"
                    value={actorClass ?? GALLERY_ARCHETYPE_ACTOR_CLASSES.ground[0]}
                    onChange={(value) => setActorClass(value as GalleryActorClass)}
                    options={GROUND_CLASS_OPTIONS}
                    labelClassName="mb-1 text-xs text-white/45"
                  />
                ) : null}
                <div {...stylex.props(dialog.uploadSpan2)}>
                  <p {...stylex.props(dialog.uploadLabel)}>How does it move?</p>
                  <div {...stylex.props(dialog.uploadMotionGrid)} role="radiogroup" aria-label="How does it move?">
                    {MOTION_OPTIONS.map((option) => (
                      <button
                        aria-checked={archetype === option.value}
                        {...stylex.props(dialog.motionOption, archetype === option.value ? dialog.motionOptionActive : null)}
                        data-testid={`asset-motion-${option.value}`}
                        key={option.value}
                        onClick={() => selectArchetype(option.value)}
                        role="radio"
                        type="button"
                      >
                        <strong {...stylex.props(dialog.motionTitle)}>{option.label}</strong>
                        <span {...stylex.props(dialog.motionDescription)}>{option.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <label {...stylex.props(dialog.uploadLabel, dialog.uploadSpan2)}>Description<Textarea maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} {...stylex.props(dialog.uploadField)} /></label>
                <label {...stylex.props(dialog.uploadLabel, dialog.uploadSpan2)}>Tags, comma separated<Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="street-furniture, urban" {...stylex.props(dialog.uploadField)} /></label>
              </div>

              {model?.animated ? (
                <div {...stylex.props(dialog.uploadGrid2)}>
                  <SelectMenuField label="Idle clip" value={idleClip} onChange={setIdleClip} options={[{ value: "", label: "None" }, ...model.clips]} labelClassName="mb-1 text-xs text-white/45" />
                  <SelectMenuField label="Locomotion clip" value={locomotionClip} onChange={setLocomotionClip} options={[{ value: "", label: "None" }, ...model.clips]} labelClassName="mb-1 text-xs text-white/45" />
                </div>
              ) : null}
            </form>
          ) : (
            <MapUploadPanel
              formId={formId}
              uploadBlob={uploadBlob}
              responseError={responseError}
              onPhaseChange={setMapPhase}
              onStatusChange={setStatus}
              onProgressChange={setProgress}
              onErrorChange={setError}
              onPublished={onMapPublished}
            />
          )}

          <div {...stylex.props(dialog.uploadBottom)}>
            {status ? (
              <div aria-live="polite">
                <div {...stylex.props(dialog.uploadStatus)}><span>{status}</span><span>{progress}%</span></div>
                <div {...stylex.props(dialog.uploadBar)}><div {...stylex.props(dialog.uploadBarFill)} style={{ width: `${progress}%` }} /></div>
              </div>
            ) : null}
            {error ? <p role="alert" {...stylex.props(dialog.uploadText)}>{error}</p> : null}

            <div {...stylex.props(dialog.uploadActions)}>
              {kind === "map" && mapPhase === "published" ? (
                <Dialog.Close asChild><Button type="button">Done</Button></Dialog.Close>
              ) : (
                <>
                  <Dialog.Close asChild><Button type="button" variant="ghost" disabled={busy}>Cancel</Button></Dialog.Close>
                  {kind === "model" ? (
                    <Button type="submit" form={formId} disabled={!model || !actorClass || processing || uploading}><Upload />{uploading ? "Uploading…" : "Publish asset"}</Button>
                  ) : (
                    <Button type="submit" form={formId} disabled={mapPhase !== "ready"}>
                      <Upload />
                      {mapPhase === "uploading" ? "Uploading…" : mapPhase === "generating" ? "Generating…" : "Publish map"}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
