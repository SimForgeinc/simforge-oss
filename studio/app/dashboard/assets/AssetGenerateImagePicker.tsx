"use client";

import { ArrowLeft, ArrowRight, ImagePlus, X } from "lucide-react";
import { useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  GALLERY_GENERATION_MAX_IMAGES,
  GALLERY_MAX_REFERENCE_IMAGE_BYTES,
} from "@/app/lib/asset-gallery/generation-contracts";
import { prepareReferenceImage } from "./asset-generation-images";
import type { PreparedReferenceImage } from "./asset-generation-images";
import { picker } from "./asset-surfaces.stylex";

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
    <div {...stylex.props(picker.root)}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,.jpg,.jpeg,.png"
        {...stylex.props(picker.input)}
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
        {...stylex.props(picker.drop)}
      >
        <ImagePlus {...stylex.props(picker.addIcon)} aria-hidden="true" />
        <span {...stylex.props(picker.label)}>{preparing ? "Preparing photos…" : "Add reference photos"}</span>
        <span {...stylex.props(picker.hint)}>1–4 JPEG or PNG views · 8 MiB each</span>
      </button>
      {images.length > 0 ? (
        <div {...stylex.props(picker.images)} aria-label="Reference photo order">
          {images.map((image, index) => (
            <div key={image.id} {...stylex.props(picker.image)}>
              <img src={image.previewUrl} alt={`Reference ${index + 1}: ${image.name}`} {...stylex.props(picker.imagePreview)} />
              {index === 0 ? <span {...stylex.props(picker.front)}>Front view</span> : null}
              <button type="button" aria-label={`Remove ${image.name}`} onClick={() => {
                URL.revokeObjectURL(image.previewUrl);
                onChange(images.filter((candidate) => candidate.id !== image.id));
              }} {...stylex.props(picker.remove)}>
                <X {...stylex.props(picker.tinyIcon)} aria-hidden="true" />
              </button>
              <div {...stylex.props(picker.controls)}>
                <button type="button" disabled={index === 0} aria-label={`Move ${image.name} earlier`} onClick={() => move(index, -1)} {...stylex.props(picker.move)}><ArrowLeft {...stylex.props(picker.tinyIcon)} /></button>
                <span {...stylex.props(picker.view)}>View {index + 1}</span>
                <button type="button" disabled={index === images.length - 1} aria-label={`Move ${image.name} later`} onClick={() => move(index, 1)} {...stylex.props(picker.move)}><ArrowRight {...stylex.props(picker.tinyIcon)} /></button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <p {...stylex.props(picker.note)}>Put the front view first. Add clean angles of the same object with as little background clutter as possible.</p>
    </div>
  );
}
