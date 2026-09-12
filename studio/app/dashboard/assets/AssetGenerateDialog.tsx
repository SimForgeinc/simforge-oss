"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle, Sparkles, Upload, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { SelectMenuField } from "@simforge-oss/studio-ui/components/ui/select-menu";
import { Textarea } from "@simforge-oss/studio-ui/components/ui/textarea";
import {
  GALLERY_ACTOR_CLASSES,
  GalleryActorClassSchema,
  GalleryAssetSummarySchema,
} from "@simforge-oss/studio-ui/lib/asset-gallery/contracts";
import {
  galleryGenerationFailureMessage,
  GalleryGenerationSummarySchema,
  isGalleryGenerationTerminal,
} from "@/app/lib/asset-gallery/generation-contracts";
import { useVisiblePolling } from "@simforge-oss/studio-ui/lib/use-visible-polling";
import { AssetGenerateImagePicker } from "./AssetGenerateImagePicker";
import type { GalleryActorClass, GalleryAssetSummary } from "@simforge-oss/studio-ui/lib/asset-gallery/contracts";
import type { GalleryGenerationSummary } from "@/app/lib/asset-gallery/generation-contracts";
import { dialog } from "./asset-dialogs.stylex";
import type { PreparedReferenceImage } from "./asset-generation-images";

type UploadTarget = { url: string; headers: Record<string, string> };
type CreateGenerationResponse = {
  generationId: string;
  imageUploads: UploadTarget[];
};
type GenerationResponse = { generation: GalleryGenerationSummary };
type GenerationListResponse = { generations: GalleryGenerationSummary[] };
type AssetResponse = { asset: GalleryAssetSummary };
type ErrorResponse = { error?: string | { message?: string }; message?: string };

const ACTOR_CLASS_OPTIONS = GALLERY_ACTOR_CLASSES.map((value) => ({
  value,
  label: value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
}));
const API_ERROR_MESSAGES: Record<string, string> = {
  invalid_gallery_generation: "Check the asset details and reference photos, then try again.",
  gallery_generation_quota_exceeded: "You have reached the hourly generation limit. Try again later.",
  gallery_generation_unavailable: "3D asset generation is unavailable. Check Settings → AI providers.",
  gallery_generation_images_missing: "The reference photos did not finish uploading. Try again.",
  gallery_generation_forbidden: "You do not have access to this generation.",
  gallery_generation_not_found: "This generation could not be found.",
};

async function responseError(response: Response, fallback: string): Promise<string> {
  const body: ErrorResponse | null = await response.json().catch(() => null);
  // The service states the real cause (missing key, rejected key, low balance) when it knows it.
  if (typeof body?.message === "string" && body.message) return body.message;
  const code = typeof body?.error === "string" ? body.error : null;
  if (code && API_ERROR_MESSAGES[code]) return API_ERROR_MESSAGES[code];
  if (typeof body?.error === "object" && body.error?.message) return body.error.message;
  return fallback;
}

function uploadBlob(target: UploadTarget, blob: Blob, onProgress: (fraction: number) => void) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const request = new XMLHttpRequest();
  request.open("PUT", target.url);
  for (const [name, value] of Object.entries(target.headers)) request.setRequestHeader(name, value);
  request.upload.onprogress = (event) => {
    if (event.lengthComputable) onProgress(event.loaded / event.total);
  };
  request.onerror = () => reject(new Error("The reference photo upload was interrupted."));
  request.onabort = () => reject(new Error("The reference photo upload was cancelled."));
  request.onload = () => {
    if (request.status >= 200 && request.status < 300) resolve();
    else reject(new Error(`Storage rejected a reference photo (${request.status}).`));
  };
  request.send(blob);
  return promise;
}

export function AssetGenerateDialog({
  open,
  onClose,
  onPublished,
}: {
  open: boolean;
  onClose: () => void;
  onPublished: (asset: GalleryAssetSummary) => void;
}) {
  const formId = useId();
  const imagesRef = useRef<PreparedReferenceImage[]>([]);
  const publishingGenerationRef = useRef<string | null>(null);
  const publishedGenerationsRef = useRef<Record<string, true>>({});
  const [images, setImages] = useState<PreparedReferenceImage[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [texturePrompt, setTexturePrompt] = useState("");
  const [actorClass, setActorClass] = useState<GalleryActorClass>("vehicle");
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [active, setActive] = useState<GalleryGenerationSummary | null>(null);
  const [recent, setRecent] = useState<GalleryGenerationSummary[]>([]);
  const [publishedAsset, setPublishedAsset] = useState<GalleryAssetSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  imagesRef.current = images;
  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/asset-gallery/generations?limit=8", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) return;
        const body: GenerationListResponse = await response.json();
        setRecent(body.generations.map((generation) => GalleryGenerationSummarySchema.parse(generation)));
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError("Recent generations could not be loaded.");
        }
      }
    })();
    return () => controller.abort();
  }, [open]);

  const loadPublishedAsset = useCallback(async (generation: GalleryGenerationSummary) => {
    if (!generation.assetId || publishedGenerationsRef.current[generation.generationId]) return;
    if (publishingGenerationRef.current === generation.generationId) return;
    publishingGenerationRef.current = generation.generationId;
    try {
      const response = await fetch(`/api/asset-gallery/${generation.assetId}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "The published asset could not be loaded."));
      const body: AssetResponse = await response.json();
      const asset = GalleryAssetSummarySchema.parse(body.asset);
      publishedGenerationsRef.current[generation.generationId] = true;
      setPublishedAsset(asset);
      setError(null);
      onPublished(asset);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The published asset could not be loaded.");
    } finally {
      publishingGenerationRef.current = null;
    }
  }, [onPublished]);

  useEffect(() => {
    if (open && active?.state === "ready") void loadPublishedAsset(active);
  }, [open, active, loadPublishedAsset]);

  useVisiblePolling(
    async (signal) => {
      if (!active || isGalleryGenerationTerminal(active.state)) return;
      const response = await fetch(`/api/asset-gallery/generations/${active.generationId}`, {
        signal,
        cache: "no-store",
      });
      if (!response.ok) {
        setError(await responseError(response, "Generation progress could not be refreshed."));
        return;
      }
      const body: GenerationResponse = await response.json();
      const generation = GalleryGenerationSummarySchema.parse(body.generation);
      setActive(generation);
      setRecent((current) => [generation, ...current.filter((item) => item.generationId !== generation.generationId)].slice(0, 8));
      if (generation.state === "failed" || generation.state === "cancelled") {
        setError(galleryGenerationFailureMessage(generation.error ?? "provider_failed"));
      } else {
        setError(null);
      }
    },
    3_000,
    open && active !== null && !isGalleryGenerationTerminal(active.state),
    active?.generationId,
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (images.length === 0 || preparing || submitting) return;
    setSubmitting(true);
    setError(null);
    setUploadProgress(1);
    try {
      const createResponse = await fetch("/api/asset-gallery/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description: description.trim() || undefined,
          actorClass,
          texturePrompt: texturePrompt.trim() || undefined,
          images: images.map((image) => ({
            mediaType: image.mediaType,
            sha256: image.sha256,
            byteLength: image.blob.size,
          })),
        }),
      });
      if (!createResponse.ok) throw new Error(await responseError(createResponse, "Generation could not be created."));
      const created: CreateGenerationResponse = await createResponse.json();
      if (created.imageUploads.length !== images.length) throw new Error("The image upload targets did not match the selected photos.");

      const fractions = images.map(() => 0);
      await Promise.all(images.map((image, index) => uploadBlob(created.imageUploads[index]!, image.blob, (fraction) => {
        fractions[index] = fraction;
        setUploadProgress(Math.round(fractions.reduce((sum, value) => sum + value, 0) / fractions.length * 100));
      })));

      const startResponse = await fetch(`/api/asset-gallery/generations/${created.generationId}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!startResponse.ok) throw new Error(await responseError(startResponse, "Generation could not be started."));
      const body: GenerationResponse = await startResponse.json();
      const generation = GalleryGenerationSummarySchema.parse(body.generation);
      setActive(generation);
      setRecent((current) => [generation, ...current.filter((item) => item.generationId !== generation.generationId)].slice(0, 8));
      if (generation.state === "failed" || generation.state === "cancelled") {
        setError(galleryGenerationFailureMessage(generation.error ?? "provider_failed"));
      }
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
      setImages([]);
      setUploadProgress(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Generation could not be started.");
    } finally {
      setSubmitting(false);
    }
  };

  const resumable = recent.filter((generation) =>
    generation.state === "generating" ||
    generation.state === "importing" ||
    generation.state === "ready"
  );
  const generationProgress = active?.state === "generating" ? active.progress : active?.state === "importing" || active?.state === "ready" ? 100 : 0;
  const status = submitting
    ? `Uploading reference photos · ${uploadProgress}%`
    : active?.state === "generating"
      ? `Generating model · ${active.progress}%`
      : active?.state === "importing"
        ? "Importing and publishing the generated model"
        : active?.state === "ready"
          ? "Published to the asset gallery"
          : active?.state === "failed" || active?.state === "cancelled"
            ? "Generation stopped"
            : null;

  return (
    <Dialog.Root open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay {...stylex.props(dialog.overlay)} />
        <Dialog.Content {...stylex.props(dialog.content)}>
          <Dialog.Title {...stylex.props(dialog.title)}><Sparkles {...stylex.props(dialog.iconAccent)} />Generate 3D asset</Dialog.Title>
          <Dialog.Description {...stylex.props(dialog.description)}>Turn photographs of one object into a textured, gallery-ready 3D model. Generation usually takes about 90 seconds.</Dialog.Description>
          <Dialog.Close asChild><button type="button" aria-label="Close generation dialog" {...stylex.props(dialog.close)}><X {...stylex.props(dialog.iconSm)} /></button></Dialog.Close>

          {active ? (
            <div {...stylex.props(dialog.panel)}>
              <div {...stylex.props(dialog.card)}>
                {active.previewUrl ? (
                  /* Runtime provider previews are not known to Next's remote image allowlist. */
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={active.previewUrl} alt={`Generated preview of ${active.title}`} {...stylex.props(dialog.preview)} />
                ) : (
                  <div {...stylex.props(dialog.loadingPreview)}><LoaderCircle {...stylex.props(dialog.icon, dialog.progressPulse)} />Building preview…</div>
                )}
                <div {...stylex.props(dialog.card)}><p {...stylex.props(dialog.titleText)}>{active.title}</p><p {...stylex.props(dialog.mutedText)}>{active.imageCount} reference {active.imageCount === 1 ? "photo" : "photos"}</p></div>
              </div>

              {status ? (
                <div aria-live="polite">
                  <div {...stylex.props(dialog.progressText)}><span>{status}</span><span>{generationProgress}%</span></div>
                  <div {...stylex.props(dialog.progress)}><div {...stylex.props(dialog.progressBar, active.state === "importing" ? dialog.progressPulse : null)} style={{ width: `${generationProgress}%` }} /></div>
                  {active.state === "generating" || active.state === "importing" ? <p {...stylex.props(dialog.mutedText)}>You can close this dialog. Work continues in the background.</p> : null}
                </div>
              ) : null}

              {publishedAsset ? (
                <div {...stylex.props(dialog.cardSuccess)}>
                  <p {...stylex.props(dialog.successText)}>Ready to use</p>
                  <p {...stylex.props(dialog.mutedText)}>{publishedAsset.dims.l.toFixed(2)} × {publishedAsset.dims.w.toFixed(2)} × {publishedAsset.dims.h.toFixed(2)} m</p>
                  <p {...stylex.props(dialog.mutedText)}>Actors travel nose-first along +X. If this model faces the wrong way, correct its orientation from the asset drawer.</p>
                </div>
              ) : null}
              {error ? <p role="alert" {...stylex.props(dialog.errorText)}>{error}</p> : null}
              <div {...stylex.props(dialog.actionsRow)}>
                {active.state === "ready" && !publishedAsset ? <Button type="button" variant="outline" onClick={() => void loadPublishedAsset(active)}>Load published asset</Button> : null}
                {isGalleryGenerationTerminal(active.state) ? <Button type="button" variant="outline" onClick={() => { setActive(null); setPublishedAsset(null); setError(null); }}>Generate another</Button> : null}
                <Dialog.Close asChild><Button type="button">{isGalleryGenerationTerminal(active.state) ? "Done" : "Close"}</Button></Dialog.Close>
              </div>
            </div>
          ) : (
            <>
              {resumable.length > 0 ? (
                <div {...stylex.props(dialog.recent)}>
                  <p {...stylex.props(dialog.titleText)}>Recent generation</p>
                  <div {...stylex.props(dialog.recentList)}>{resumable.map((generation) => <button type="button" key={generation.generationId} onClick={() => { setActive(generation); setError(null); }} {...stylex.props(dialog.recentItem)}><span>{generation.title}</span><span {...stylex.props(dialog.accentText)}>{generation.state === "ready" ? "View result" : `Rejoin · ${generation.state === "importing" ? "importing" : `${generation.progress}%`}`}</span></button>)}</div>
                </div>
              ) : null}

              <form id={formId} onSubmit={submit} {...stylex.props(dialog.form)}>
                <AssetGenerateImagePicker images={images} onChange={setImages} onBusyChange={setPreparing} onError={setError} />
                <div {...stylex.props(dialog.grid)}>
                  <label {...stylex.props(dialog.fieldLabel)}>Title<Input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} {...stylex.props(dialog.fieldControl)} /></label>
                  <SelectMenuField label="Actor class" value={actorClass} onChange={(value) => { const parsed = GalleryActorClassSchema.safeParse(value); if (parsed.success) setActorClass(parsed.data); }} options={ACTOR_CLASS_OPTIONS} labelClassName="mb-1 text-xs text-white/45" />
                  <label {...stylex.props(dialog.fieldLabel, dialog.span2)}>Description<Textarea maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} {...stylex.props(dialog.fieldControl)} /></label>
                  <label {...stylex.props(dialog.fieldLabel, dialog.span2)}>Texture guidance<Textarea maxLength={600} value={texturePrompt} onChange={(event) => setTexturePrompt(event.target.value)} placeholder="Matte black paint, no decals" {...stylex.props(dialog.fieldControl)} /><span {...stylex.props(dialog.subText)}>Steers surface appearance only, not the model’s shape.</span></label>
                </div>
              </form>

              <div {...stylex.props(dialog.footer)}>
                {submitting ? <div aria-live="polite"><div {...stylex.props(dialog.progressText)}><span>{status}</span><span>{uploadProgress}%</span></div><div {...stylex.props(dialog.progress)}><div {...stylex.props(dialog.progressBar)} style={{ width: `${uploadProgress}%` }} /></div></div> : null}
                {error ? <p role="alert" {...stylex.props(dialog.errorText)}>{error}</p> : null}
                <div {...stylex.props(dialog.actionsRow)}><Dialog.Close asChild><Button type="button" variant="ghost">Cancel</Button></Dialog.Close><Button type="submit" form={formId} disabled={images.length === 0 || !title.trim() || preparing || submitting}><Upload />{submitting ? "Starting…" : "Generate asset"}</Button></div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
