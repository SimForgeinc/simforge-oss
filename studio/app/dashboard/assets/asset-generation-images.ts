import type { GalleryReferenceImageMediaType } from "@/app/lib/asset-gallery/generation-contracts";

export interface PreparedReferenceImage {
  id: string;
  name: string;
  blob: Blob;
  mediaType: GalleryReferenceImageMediaType;
  sha256: string;
  previewUrl: string;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  canvas.toBlob(
    (blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not prepare this photo."));
    },
    "image/jpeg",
    0.86,
  );
  return promise;
}

export async function prepareReferenceImage(file: File): Promise<PreparedReferenceImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("This browser cannot prepare reference photos.");
  }

  // Meshy derives geometry from the visible views, not source pixel density. A
  // bounded JPEG cuts upload time and provider input size without changing the
  // geometry quality available from an ordinary reference photograph.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await canvasBlob(canvas);
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    id: crypto.randomUUID(),
    name: file.name,
    blob,
    mediaType: "image/jpeg",
    sha256,
    previewUrl: URL.createObjectURL(blob),
  };
}
