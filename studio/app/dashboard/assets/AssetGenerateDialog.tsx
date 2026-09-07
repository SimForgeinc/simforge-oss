"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle, Sparkles, Upload, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/75 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[210] max-h-[92vh] w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-white/10 bg-[#0d1014] p-6 text-white shadow-2xl outline-none">
          <Dialog.Title className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Sparkles className="size-5 text-[#E8E044]" />Generate 3D asset</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-white/45">Turn photographs of one object into a textured, gallery-ready 3D model. Generation usually takes about 90 seconds.</Dialog.Description>
          <Dialog.Close asChild><button type="button" aria-label="Close generation dialog" className="absolute right-4 top-4 rounded-md p-2 text-white/45 hover:bg-white/5 hover:text-white"><X className="size-4" /></button></Dialog.Close>

          {active ? (
            <div className="mt-6 space-y-5">
              <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
                {active.previewUrl ? (
                  /* Runtime provider previews are not known to Next's remote image allowlist. */
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={active.previewUrl} alt={`Generated preview of ${active.title}`} className="aspect-[16/9] w-full bg-[radial-gradient(circle,#27303a,#101317)] object-contain" />
                ) : (
                  <div className="flex aspect-[16/7] items-center justify-center text-white/30"><LoaderCircle className="mr-2 size-5 animate-spin" />Building preview…</div>
                )}
                <div className="p-4"><p className="font-medium">{active.title}</p><p className="mt-1 text-xs text-white/40">{active.imageCount} reference {active.imageCount === 1 ? "photo" : "photos"}</p></div>
              </div>

              {status ? (
                <div aria-live="polite">
                  <div className="mb-1 flex justify-between text-xs text-white/45"><span>{status}</span><span>{generationProgress}%</span></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><div className={`h-full bg-[#E8E044] transition-[width] ${active.state === "importing" ? "animate-pulse" : ""}`} style={{ width: `${generationProgress}%` }} /></div>
                  {active.state === "generating" || active.state === "importing" ? <p className="mt-2 text-xs text-white/35">You can close this dialog. Work continues in the background.</p> : null}
                </div>
              ) : null}

              {publishedAsset ? (
                <div className="rounded-xl border border-emerald-300/20 bg-emerald-300/[0.06] p-4">
                  <p className="text-sm font-medium text-emerald-100">Ready to use</p>
                  <p className="mt-1 text-xs text-white/55">{publishedAsset.dims.l.toFixed(2)} × {publishedAsset.dims.w.toFixed(2)} × {publishedAsset.dims.h.toFixed(2)} m</p>
                  <p className="mt-2 text-xs text-white/55">Actors travel nose-first along +X. If this model faces the wrong way, correct its orientation from the asset drawer.</p>
                </div>
              ) : null}
              {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
              <div className="flex justify-end gap-2">
                {active.state === "ready" && !publishedAsset ? <Button type="button" variant="outline" onClick={() => void loadPublishedAsset(active)}>Load published asset</Button> : null}
                {isGalleryGenerationTerminal(active.state) ? <Button type="button" variant="outline" onClick={() => { setActive(null); setPublishedAsset(null); setError(null); }}>Generate another</Button> : null}
                <Dialog.Close asChild><Button type="button">{isGalleryGenerationTerminal(active.state) ? "Done" : "Close"}</Button></Dialog.Close>
              </div>
            </div>
          ) : (
            <>
              {resumable.length > 0 ? (
                <div className="mt-5 rounded-xl border border-[#E8E044]/20 bg-[#E8E044]/[0.04] p-4">
                  <p className="text-sm font-medium">Recent generation</p>
                  <div className="mt-2 space-y-2">{resumable.map((generation) => <button type="button" key={generation.generationId} onClick={() => { setActive(generation); setError(null); }} className="flex w-full items-center justify-between rounded-lg bg-white/[0.04] px-3 py-2 text-left text-sm hover:bg-white/[0.07]"><span>{generation.title}</span><span className="text-xs text-[#E8E044]">{generation.state === "ready" ? "View result" : `Rejoin · ${generation.state === "importing" ? "importing" : `${generation.progress}%`}`}</span></button>)}</div>
                </div>
              ) : null}

              <form id={formId} onSubmit={submit} className="mt-6 space-y-5">
                <AssetGenerateImagePicker images={images} onChange={setImages} onBusyChange={setPreparing} onError={setError} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-xs text-white/45">Title<Input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1" /></label>
                  <SelectMenuField label="Actor class" value={actorClass} onChange={(value) => { const parsed = GalleryActorClassSchema.safeParse(value); if (parsed.success) setActorClass(parsed.data); }} options={ACTOR_CLASS_OPTIONS} labelClassName="mb-1 text-xs text-white/45" />
                  <label className="text-xs text-white/45 sm:col-span-2">Description<Textarea maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} className="mt-1" /></label>
                  <label className="text-xs text-white/45 sm:col-span-2">Texture guidance<Textarea maxLength={600} value={texturePrompt} onChange={(event) => setTexturePrompt(event.target.value)} placeholder="Matte black paint, no decals" className="mt-1" /><span className="mt-1 block text-[11px] leading-4 text-white/35">Steers surface appearance only, not the model’s shape.</span></label>
                </div>
              </form>

              <div className="mt-5 space-y-5">
                {submitting ? <div aria-live="polite"><div className="mb-1 flex justify-between text-xs text-white/45"><span>{status}</span><span>{uploadProgress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full bg-[#E8E044] transition-[width]" style={{ width: `${uploadProgress}%` }} /></div></div> : null}
                {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
                <div className="flex justify-end gap-2"><Dialog.Close asChild><Button type="button" variant="ghost">Cancel</Button></Dialog.Close><Button type="submit" form={formId} disabled={images.length === 0 || !title.trim() || preparing || submitting}><Upload />{submitting ? "Starting…" : "Generate asset"}</Button></div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
