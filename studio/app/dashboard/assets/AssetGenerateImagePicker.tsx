"use client";

import { ArrowLeft, ArrowRight, ImagePlus, X } from "lucide-react";
import { useRef, useState } from "react";
import {
  GALLERY_GENERATION_MAX_IMAGES,
  GALLERY_MAX_REFERENCE_IMAGE_BYTES,
} from "@/app/lib/asset-gallery/generation-contracts";
import { prepareReferenceImage } from "./asset-generation-images";
import type { PreparedReferenceImage } from "./asset-generation-images";

export function AssetGenerateImagePicker({
  images,
  onChange,
  onBusyChange,
  onError,
}: {
  images: PreparedReferenceImage[];
  onChange: (images: PreparedReferenceImage[]) => void;
  onBusyChange: (busy: boolean) => void;
  onError: (error: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);

  const chooseFiles = async (selected: File[]) => {
    if (selected.length === 0 || preparing) return;
    const remaining = GALLERY_GENERATION_MAX_IMAGES - images.length;
    if (remaining <= 0) {
      onError(`Choose no more than ${GALLERY_GENERATION_MAX_IMAGES} reference photos.`);
      return;
    }

    let validationError: string | null = null;
    const valid = selected.filter((file) => {
      if (file.type !== "image/jpeg" && file.type !== "image/png") {
        validationError = "Reference photos must be JPEG or PNG files.";
        return false;
      }
      if (file.size > GALLERY_MAX_REFERENCE_IMAGE_BYTES) {
        validationError = `Each reference photo must be ${GALLERY_MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024} MiB or smaller.`;
        return false;
      }
      return true;
    });
    if (valid.length > remaining || selected.length > remaining) {
      validationError = `Choose no more than ${GALLERY_GENERATION_MAX_IMAGES} reference photos.`;
    }
    onError(validationError);

    const accepted = valid.slice(0, remaining);
    if (accepted.length === 0) return;
    setPreparing(true);
    onBusyChange(true);
    try {
      const prepared = await Promise.all(accepted.map(prepareReferenceImage));
      onChange([...images, ...prepared]);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "The reference photos could not be prepared.");
    } finally {
      setPreparing(false);
      onBusyChange(false);
    }
  };

  const move = (index: number, offset: -1 | 1) => {
    const next = [...images];
    const destination = index + offset;
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,.jpg,.jpeg,.png"
        className="sr-only"
        aria-label="Reference photos"
        onChange={(event) => {
          void chooseFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={preparing || images.length >= GALLERY_GENERATION_MAX_IMAGES}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void chooseFiles(Array.from(event.dataTransfer.files));
        }}
        className="flex min-h-28 w-full flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.025] px-6 text-center transition-colors hover:border-[#E8E044]/40 hover:bg-[#E8E044]/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] disabled:cursor-not-allowed disabled:opacity-45"
      >
        <ImagePlus className="mb-2 size-6 text-[#E8E044]" aria-hidden="true" />
        <span className="text-sm font-medium">{preparing ? "Preparing photos…" : "Add reference photos"}</span>
        <span className="mt-1 text-xs text-white/35">1–4 JPEG or PNG views · 8 MiB each</span>
      </button>

      {images.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Reference photo order">
          {images.map((image, index) => (
            <div key={image.id} className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
              {/* Blob URLs are browser-local previews and cannot pass through Next Image. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.previewUrl} alt={`Reference ${index + 1}: ${image.name}`} className="aspect-square w-full object-cover" />
              {index === 0 ? (
                <span className="absolute left-2 top-2 rounded-full bg-[#E8E044] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black">Front view</span>
              ) : null}
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => {
                  URL.revokeObjectURL(image.previewUrl);
                  onChange(images.filter((candidate) => candidate.id !== image.id));
                }}
                className="absolute right-1.5 top-1.5 rounded-full bg-black/70 p-1 text-white/70 hover:text-white"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
              <div className="flex items-center justify-between gap-1 px-1.5 py-1.5">
                <button type="button" disabled={index === 0} aria-label={`Move ${image.name} earlier`} onClick={() => move(index, -1)} className="rounded p-1 text-white/55 hover:bg-white/10 hover:text-white disabled:opacity-20"><ArrowLeft className="size-3.5" /></button>
                <span className="min-w-0 truncate text-[10px] text-white/45">View {index + 1}</span>
                <button type="button" disabled={index === images.length - 1} aria-label={`Move ${image.name} later`} onClick={() => move(index, 1)} className="rounded p-1 text-white/55 hover:bg-white/10 hover:text-white disabled:opacity-20"><ArrowRight className="size-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <p className="text-xs leading-5 text-white/40">Put the front view first. Add clean angles of the same object with as little background clutter as possible.</p>
    </div>
  );
}
