"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./map-assets.stylex";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Box, ChevronDown, Film, FolderUp, Image as ImageIcon, Trash2, Undo2, X } from "lucide-react";
import {
  MAP_ASSET_DESCRIPTOR_TAG_IDS,
  getMapAssetDescriptorTag,
} from "@simforge-oss/studio-shared";
import type { MapAsset, MapAssetArtifactType } from "@simforge-oss/studio-shared";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { MapAssetDangerZone } from "./MapAssetDangerZone";
import {
  artifactTypeFromFilename,
  buildMapCoordinateRefPayload,
  buildPlaceContextPayload,
  displayTag,
  newEntry,
  sha256Hex,
  type MediaEntry,
} from "./MapAssetEditPanelUtils";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className={stylex.props(styles.s_0).className}>
      {children}
    </h3>
  );
}

type Props = {
  asset: MapAsset;
  onBack: () => void;
  /** Called after a successful save so the parent can refresh data then close. */
  onSaved?: () => void;
  /** Called after a successful permanent delete (e.g. clear selection and refresh). */
  onDeleted?: () => void;
};

/** Side panel for editing map asset metadata, tags, media, and deletion. */
export function MapAssetEditPanel({ asset, onBack, onSaved, onDeleted }: Props) {
  const router = useRouter();

  // ── Place context ──────────────────────────────────────────────────────────
  const [placeCity, setPlaceCity] = useState(asset.place_context?.city ?? "");
  const [placeState, setPlaceState] = useState(asset.place_context?.state ?? "");
  const [placeCountry, setPlaceCountry] = useState(asset.place_context?.country ?? "");
  const [editorOffsetX, setEditorOffsetX] = useState(
    String(asset.map_coordinate_ref?.editor_offset_m?.x ?? 0),
  );
  const [editorOffsetY, setEditorOffsetY] = useState(
    String(asset.map_coordinate_ref?.editor_offset_m?.y ?? 0),
  );

  // ── CARLA map name ─────────────────────────────────────────────────────────
  const [carlaMapName, setCarlaMapName] = useState(asset.carla_map_name ?? "");

  // ── Satellite imagery (SimScene image services) ────────────────────────────
  // A map can need several tilesets to cover its full extent, so this is a list
  // of {tileset_id, layer_id} rows, stacked bottom-to-top as raster layers.
  const [imageryTilesets, setImageryTilesets] = useState<{ tileset_id: string; layer_id: string }[]>(
    asset.imagery_tilesets?.map((t) => ({ tileset_id: t.tileset_id, layer_id: t.layer_id })) ?? [],
  );

  function updateImageryRow(index: number, field: "tileset_id" | "layer_id", value: string) {
    setImageryTilesets((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }
  function addImageryRow() {
    setImageryTilesets((prev) => [...prev, { tileset_id: "", layer_id: "" }]);
  }
  function removeImageryRow(index: number) {
    setImageryTilesets((prev) => prev.filter((_, i) => i !== index));
  }

  // ── Tags ──────────────────────────────────────────────────────────────────
  const [tags, setTags] = useState<string[]>(asset.tags ?? []);
  const [csvInput, setCsvInput] = useState("");
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvOpen, setCsvOpen] = useState(false);
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const tagDropdownRef = useRef<HTMLDivElement>(null);

  function removeTag(id: string) {
    setTags((prev) => prev.filter((t) => t !== id));
  }

  // Close tag dropdown on click outside
  useEffect(() => {
    if (!tagDropdownOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setTagDropdownOpen(false);
        setTagSearch("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [tagDropdownOpen]);

  const filteredDropdownTags = MAP_ASSET_DESCRIPTOR_TAG_IDS.filter((id) => {
    if (tags.includes(id)) return false;
    const q = tagSearch.toLowerCase();
    return id.toLowerCase().includes(q) || displayTag(id).toLowerCase().includes(q);
  });

  function applyCSV() {
    const entries = csvInput
      .split(",")
      .map((s) => s.trim().replace(/^["'[\]\s]+|["'[\]\s]+$/g, "").toUpperCase())
      .filter(Boolean);
    const valid = [...new Set(entries.filter((id) => MAP_ASSET_DESCRIPTOR_TAG_IDS.includes(id)))];
    const invalid = [...new Set(entries.filter((id) => !MAP_ASSET_DESCRIPTOR_TAG_IDS.includes(id)))];
    setCsvErrors(invalid);
    if (valid.length > 0) {
      setTags((prev) => [...new Set([...prev, ...valid])]);
      setCsvInput("");
    }
  }

  // ── Media ─────────────────────────────────────────────────────────────────
  const [videoEntries, setVideoEntries] = useState<MediaEntry[]>([]);
  const [imageEntries, setImageEntries] = useState<MediaEntry[]>([]);
  /** URIs of existing artifacts (videos/images) to remove on save */
  const [artifactUrisToDelete, setArtifactUrisToDelete] = useState<Set<string>>(new Set());
  const videoInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // ── 3D Digital Twin ──────────────────────────────────────────────────────
  const [threeDFiles, setThreeDFiles] = useState<File[]>([]);
  const [threeDUploadProgress, setThreeDUploadProgress] = useState<{
    total: number;
    completed: number;
    currentFile: string;
  } | null>(null);
  const [delete3D, setDelete3D] = useState(false);
  const threeDInputRef = useRef<HTMLInputElement>(null);

  const existing3dManifest = asset.artifacts.find(
    (a) => (a.artifact_type as string) === "3d_manifest",
  );
  const has3D = !!existing3dManifest && !delete3D;

  function handleThreeDFolderSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    // Validate manifest.json exists at the root of the selected folder
    const hasManifest = files.some((f) => {
      const parts = f.webkitRelativePath.split("/");
      // webkitRelativePath = "folderName/manifest.json" (exactly 2 parts)
      return parts.length === 2 && parts[1] === "manifest.json";
    });

    if (!hasManifest) {
      toast.error("Selected folder must contain a manifest.json at its root");
      e.target.value = "";
      return;
    }

    setThreeDFiles(files);
    // If we had marked 3D for deletion, undo that since we're uploading new ones
    if (delete3D) {
      setDelete3D(false);
      if (existing3dManifest) {
        setArtifactUrisToDelete((prev) => {
          const next = new Set(prev);
          next.delete(existing3dManifest.uri);
          return next;
        });
      }
    }
    e.target.value = "";
  }

  function handleDelete3D() {
    setDelete3D(true);
    if (existing3dManifest) {
      markArtifactForDeletion(existing3dManifest.uri);
    }
    // Clear any pending 3D upload
    setThreeDFiles([]);
  }

  function handleUndelete3D() {
    setDelete3D(false);
    if (existing3dManifest) {
      setArtifactUrisToDelete((prev) => {
        const next = new Set(prev);
        next.delete(existing3dManifest.uri);
        return next;
      });
    }
  }

  function markArtifactForDeletion(uri: string) {
    setArtifactUrisToDelete((prev) => new Set(prev).add(uri));
  }

  function addFiles(
    e: React.ChangeEvent<HTMLInputElement>,
    setter: React.Dispatch<React.SetStateAction<MediaEntry[]>>
  ) {
    const files = Array.from(e.target.files ?? []);
    setter((prev) => [...prev, ...files.map(newEntry)]);
    e.target.value = "";
  }

  function updateLabel(
    id: string,
    label: string,
    setter: React.Dispatch<React.SetStateAction<MediaEntry[]>>
  ) {
    setter((prev) => prev.map((e) => (e.id === id ? { ...e, label } : e)));
  }

  function removeEntry(
    id: string,
    setter: React.Dispatch<React.SetStateAction<MediaEntry[]>>
  ) {
    setter((prev) => prev.filter((e) => e.id !== id));
  }

  // ── Signed-in email for delete confirmation ──
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { user?: { email?: string | null } } | null) => {
        if (cancelled || !data?.user) return;
        setSessionEmail(data.user.email?.trim() || null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSessionLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Delete map ─────────────────────────────────────────────────────────────
  const [deleteConfirmEmail, setDeleteConfirmUsername] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [dangerOpen, setDangerOpen] = useState(false);

  function emailsMatch(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  async function handleDeleteMap() {
    setDeleteError(null);
    const trimmed = deleteConfirmEmail.trim();
    if (!sessionEmail || !emailsMatch(trimmed, sessionEmail)) {
      setDeleteError("Type your email address exactly as shown below to confirm deletion.");
      return;
    }
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/map-assets/${asset.map_asset_id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEmail: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const msg = body.error ?? `Delete failed (${res.status})`;
        setDeleteError(msg);
        toast.error(msg);
        return;
      }
      toast.success("Map deleted");
      onDeleted?.();
    } catch {
      const msg = "Network error while deleting map.";
      setDeleteError(msg);
      toast.error(msg);
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleSave() {
    setError(null);
    setSubmitting(true);
    try {
      const newArtifacts: { key: string; artifact_type: MapAssetArtifactType; sha256: string; label?: string; size_bytes?: number }[] = [];

      // ── 3D folder upload ────────────────────────────────────────────────
      if (threeDFiles.length > 0) {
        // Strip the top-level folder name from webkitRelativePath
        const filesWithPaths = threeDFiles.map((f) => {
          const parts = f.webkitRelativePath.split("/");
          const relativePath = parts.slice(1).join("/");
          return { file: f, relativePath };
        });

        // Get presigned URLs for all 3D files
        const urlsRes = await fetch(`/api/map-assets/${asset.map_asset_id}/upload-3d-urls`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: filesWithPaths.map((f, i) => ({
              id: String(i),
              relativePath: f.relativePath,
              contentType: f.file.type || undefined,
            })),
          }),
        });
        if (!urlsRes.ok) {
          const body = await urlsRes.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `3D upload URL generation failed (${urlsRes.status})`);
        }
        const { uploads: threeDUploads } = (await urlsRes.json()) as { uploads: { id: string; url: string; key: string; contentType: string }[] };

        // Upload all files concurrently with a concurrency limit
        setThreeDUploadProgress({ total: threeDUploads.length, completed: 0, currentFile: "" });
        const CONCURRENCY = 6;
        let completed = 0;
        const queue = threeDUploads.map((u, i) => ({ upload: u, fileEntry: filesWithPaths[i]! }));

        async function uploadOne(item: (typeof queue)[0]) {
          setThreeDUploadProgress((p) => p && ({ ...p, currentFile: item.fileEntry.relativePath }));
          const res = await fetch(item.upload.url, {
            method: "PUT",
            body: item.fileEntry.file,
            headers: { "Content-Type": item.upload.contentType },
          });
          if (!res.ok) {
            throw new Error(`Upload failed for ${item.fileEntry.relativePath}: ${res.status}`);
          }
          completed++;
          setThreeDUploadProgress((p) => p && ({ ...p, completed }));
        }

        const executing = new Set<Promise<void>>();
        for (const item of queue) {
          const p = uploadOne(item).then(() => { executing.delete(p); });
          executing.add(p);
          if (executing.size >= CONCURRENCY) {
            await Promise.race(executing);
          }
        }
        await Promise.all(executing);
        setThreeDUploadProgress(null);

        // Register the 3d_manifest artifact
        const manifestEntry = filesWithPaths.find((f) => f.relativePath === "manifest.json");
        const manifestUpload = threeDUploads.find((u) => u.key.endsWith("/manifest.json"));
        if (manifestEntry && manifestUpload) {
          const manifestSha = await sha256Hex(manifestEntry.file);
          newArtifacts.push({
            key: manifestUpload.key,
            artifact_type: "3d_manifest",
            sha256: manifestSha,
            label: "3D Digital Twin",
            size_bytes: manifestEntry.file.size,
          });
        }
      }

      // ── Media uploads (videos/images) ───────────────────────────────────
      const placeContextPayload = buildPlaceContextPayload(placeCity, placeState, placeCountry, asset.place_context);
      const mapCoordinateRefPayload = buildMapCoordinateRefPayload(
        editorOffsetX,
        editorOffsetY,
        asset.map_coordinate_ref,
      );
      const allMedia = [...videoEntries, ...imageEntries];

      if (allMedia.length > 0) {
        const files = allMedia.map((e, i) => ({
          id: String(i),
          filename: e.file.name,
          contentType: e.file.type || (e.file.name.toLowerCase().endsWith(".mp4") ? "video/mp4" : "image/jpeg"),
        }));
        const urlsRes = await fetch(`/api/map-assets/${asset.map_asset_id}/upload-urls`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files }),
        });
        if (!urlsRes.ok) {
          const body = await urlsRes.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `Upload URLs failed (${urlsRes.status})`);
        }
        const { uploads } = (await urlsRes.json()) as { uploads: { id: string; url: string; key: string }[] };

        const sha256s = await Promise.all(allMedia.map((e) => sha256Hex(e.file)));

        for (let i = 0; i < uploads.length; i++) {
          const { url } = uploads[i]!;
          const file = allMedia[i]!.file;
          const contentType = files[i]!.contentType;
          const putRes = await fetch(url, {
            method: "PUT",
            body: file,
            headers: { "Content-Type": contentType },
          });
          if (!putRes.ok) {
            throw new Error(`Upload failed for ${file.name}: ${putRes.status}`);
          }
        }

        for (let i = 0; i < uploads.length; i++) {
          newArtifacts.push({
            key: uploads[i]!.key,
            artifact_type: artifactTypeFromFilename(allMedia[i]!.file.name),
            sha256: sha256s[i]!,
            label: allMedia[i]!.label?.trim() || undefined,
          });
        }
      }

      // ── PATCH map asset ─────────────────────────────────────────────────
      const res = await fetch(`/api/map-assets/${asset.map_asset_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tags,
          deleteArtifactUris: artifactUrisToDelete.size > 0 ? [...artifactUrisToDelete] : undefined,
          newArtifacts: newArtifacts.length > 0 ? newArtifacts : undefined,
          placeContext: placeContextPayload,
          mapCoordinateRef: mapCoordinateRefPayload,
          carlaMapName: carlaMapName.trim() || null,
          imageryTilesets: imageryTilesets
            .map((t) => ({ tileset_id: t.tileset_id.trim(), layer_id: t.layer_id.trim() }))
            .filter((t) => t.tileset_id && t.layer_id),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
      }

      if (onSaved) {
        onSaved();
      } else {
        router.refresh();
        onBack();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setThreeDUploadProgress(null);
      setSubmitting(false);
    }
  }

  const existingVideos = asset.artifacts.filter(
    (a) => a.artifact_type === "mp4" && !artifactUrisToDelete.has(a.uri)
  );
  const existingImages = asset.artifacts.filter(
    (a) => a.artifact_type === "image" && !artifactUrisToDelete.has(a.uri)
  );

  return (
    <div className={stylex.props(styles.s_1).className}>

      {/* Header */}
      <div className={stylex.props(styles.s_2).className}>
        <Button
          variant="ghost"
          size="icon"
          xstyle={styles.s_132}
          onClick={onBack}
          aria-label="Back to details"
          title="Back to map details"
        >
          <ArrowLeft className={stylex.props(styles.s_991).className} />
        </Button>
        <div className={stylex.props(styles.s_761).className}>
          <p className={stylex.props(styles.s_973).className}>Editing</p>
          <p className={stylex.props(styles.s_7).className}>{asset.name}</p>
        </div>
      </div>

      {/* Scrollable body */}
      <div className={stylex.props(styles.s_8).className}>

        {/* Place context */}
        <section>
          <SectionHeading>Location</SectionHeading>
          <p className={stylex.props(styles.s_117).className}>
            Auto-filled from map coordinates. Override to correct the nearest-city result.
          </p>
          <div className={stylex.props(styles.s_960).className}>
            <div>
              <label className={stylex.props(styles.s_37).className}>City</label>
              <Input
                value={placeCity}
                onChange={(e) => setPlaceCity(e.target.value)}
                placeholder={asset.place_context?.city ?? "e.g. San Jose"}
                xstyle={styles.s_288}
              />
            </div>
            <div>
              <label className={stylex.props(styles.s_37).className}>State / Region</label>
              <Input
                value={placeState}
                onChange={(e) => setPlaceState(e.target.value)}
                placeholder={asset.place_context?.state ?? "e.g. California"}
                xstyle={styles.s_288}
              />
            </div>
            <div>
              <label className={stylex.props(styles.s_37).className}>Country</label>
              <Input
                value={placeCountry}
                onChange={(e) => setPlaceCountry(e.target.value)}
                placeholder={asset.place_context?.country ?? "e.g. United States"}
                xstyle={styles.s_288}
              />
            </div>
          </div>
        </section>

        {/* CARLA map name */}
        <section>
          <SectionHeading>CARLA map name</SectionHeading>
          <p className={stylex.props(styles.s_117).className}>
            Identifier used by the CARLA simulator for this map.
          </p>
          <label htmlFor="carla-map-name" className={stylex.props(styles.s_997).className}>CARLA map name</label>
          <Input
            id="carla-map-name"
            value={carlaMapName}
            onChange={(e) => setCarlaMapName(e.target.value)}
            placeholder="e.g. Belmont_Office_Park_Belmont_CA"
            xstyle={styles.s_38}
          />
        </section>

        {/* Satellite imagery */}
        <section>
          <SectionHeading>Satellite imagery</SectionHeading>
          <p className={stylex.props(styles.s_117).className}>
            SimScene image services serving this map&apos;s ortho imagery. Add one per tileset
            (with its RGB layer); a map can need several to cover its full extent. They stack
            top-to-bottom in the order listed. Leave empty for no satellite basemap.
          </p>
          {/* `space-y-2` lives on the children here: the trailing "+ Add" control
              is an inline-level <button>, so a flex column would blockify it and
              lose both its shrink-to-fit width and its line-box leading. */}
          <div>
            {imageryTilesets.length === 0 ? (
              <p className={stylex.props(styles.s_22, styles.stackY2).className}>No image services configured.</p>
            ) : (
              imageryTilesets.map((row, index) => (
                <div key={index} className={stylex.props(styles.s_23, styles.stackY2).className}>
                  <div className={stylex.props(styles.s_24).className}>
                    <span className={stylex.props(styles.s_25).className}>
                      Image service {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeImageryRow(index)}
                      className={stylex.props(styles.s_26).className}
                      aria-label={`Remove image service ${index + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                  <div className={stylex.props(styles.s_986).className}>
                    <div>
                      <label
                        htmlFor={`imagery-tileset-id-${index}`}
                        className={stylex.props(styles.s_37).className}
                      >
                        Tileset ID
                      </label>
                      <Input
                        id={`imagery-tileset-id-${index}`}
                        value={row.tileset_id}
                        onChange={(e) => updateImageryRow(index, "tileset_id", e.target.value)}
                        placeholder="e.g. 019f1d21-97c7-7326-b542-e3566870c679"
                        xstyle={styles.s_38}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`imagery-layer-id-${index}`}
                        className={stylex.props(styles.s_37).className}
                      >
                        Layer ID
                      </label>
                      <Input
                        id={`imagery-layer-id-${index}`}
                        value={row.layer_id}
                        onChange={(e) => updateImageryRow(index, "layer_id", e.target.value)}
                        placeholder="e.g. a92b15c6-b541-4074-8455-dcdecc7ec193"
                        xstyle={styles.s_38}
                      />
                    </div>
                  </div>
                </div>
              ))
            )}
            <button
              type="button"
              onClick={addImageryRow}
              className={stylex.props(styles.s_32, styles.stackY2).className}
            >
              + Add image service
            </button>
          </div>
        </section>

        {/* Editor alignment */}
        <section>
          <SectionHeading>Editor alignment</SectionHeading>
          <p className={stylex.props(styles.s_117).className}>
            Meter offset added to this map&apos;s projected coordinates before drawing Simcloud overlays in the scenario editor.
          </p>
          <div className={stylex.props(styles.s_857).className}>
            <div>
              <label className={stylex.props(styles.s_37).className}>X offset (m)</label>
              <Input
                value={editorOffsetX}
                onChange={(e) => setEditorOffsetX(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                xstyle={styles.s_38}
              />
            </div>
            <div>
              <label className={stylex.props(styles.s_37).className}>Y offset (m)</label>
              <Input
                value={editorOffsetY}
                onChange={(e) => setEditorOffsetY(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                xstyle={styles.s_38}
              />
            </div>
          </div>
        </section>

        {/* Scenario tags */}
        <section>
          <SectionHeading>
            Scenario tags{tags.length > 0 && (
              <span className={stylex.props(styles.s_39).className}>
                {tags.length}
              </span>
            )}
          </SectionHeading>

          {/* Selected chips */}
          {tags.length > 0 && (
            <div className={stylex.props(styles.s_40).className}>
              {tags.map((id) => {
                const descriptor = getMapAssetDescriptorTag(id);
                return (
                  <span
                    key={id}
                    title={descriptor?.shortDefinition}
                    className={stylex.props(styles.s_41).className}
                  >
                    {displayTag(id)}
                    <button
                      type="button"
                      onClick={() => removeTag(id)}
                      aria-label={`Remove ${id}`}
                      className={stylex.props(styles.s_42).className}
                    >
                      <X className={stylex.props(styles.s_967).className} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* Add tag button + searchable dropdown */}
          <div className={stylex.props(styles.s_44).className} ref={tagDropdownRef}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              xstyle={styles.s_288}
              onClick={() => { setTagDropdownOpen((o) => !o); setTagSearch(""); }}
            >
              + Add tag
            </Button>
            {tagDropdownOpen && (
              <div className={stylex.props(styles.s_46).className}>
                <div className={stylex.props(styles.s_276).className}>
                  <Input
                    value={tagSearch}
                    onChange={(e) => setTagSearch(e.target.value)}
                    placeholder="Search tags..."
                    xstyle={styles.s_288}
                    autoFocus
                  />
                </div>
                <ul className={stylex.props(styles.s_278).className}>
                  {filteredDropdownTags.length === 0 && (
                    <li className={stylex.props(styles.s_279).className}>No matching tags</li>
                  )}
                  {filteredDropdownTags.map((tagId) => {
                    const descriptor = getMapAssetDescriptorTag(tagId);
                    return (
                      <li key={tagId}>
                        <button
                          type="button"
                          className={stylex.props(styles.s_280).className}
                          onClick={() => {
                            setTags((prev) =>
                              prev.includes(tagId) ? prev : [...prev, tagId],
                            );
                            setTagDropdownOpen(false);
                            setTagSearch("");
                          }}
                        >
                          <span className={stylex.props(styles.s_281).className}>{displayTag(tagId)}</span>
                          {descriptor?.shortDefinition && (
                            <span className={stylex.props(styles.s_1005).className}>{descriptor.shortDefinition}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          {/* CSV paste — secondary escape hatch */}
          <div className={stylex.props(styles.s_716).className}>
            <button
              type="button"
              onClick={() => setCsvOpen((o) => !o)}
              className={stylex.props(styles.s_351).className}
            >
              <ChevronDown
                className={stylex.props(styles.chevron, !csvOpen && styles.rotateMinus90).className}
              />
              Bulk-add via CSV
            </button>
            {csvOpen && (
              <div className={stylex.props(styles.inlineStackMt2).className}>
                <textarea
                  value={csvInput}
                  onChange={(e) => { setCsvInput(e.target.value); setCsvErrors([]); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applyCSV(); }
                  }}
                  placeholder={"SCHOOL_ZONE_BOUNDARY,\nINTERSECTION_SIGNALIZED"}
                  spellCheck={false}
                  rows={3}
                  className={stylex.props(styles.s_285, styles.stackY1_5).className}
                />
                {csvErrors.length > 0 && (
                  <p className={stylex.props(styles.s_451, styles.stackY1_5).className}>
                    Unrecognised (ignored):{" "}
                    <span className={stylex.props(styles.s_940).className}>{csvErrors.join(", ")}</span>
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  xstyle={[styles.s_288, styles.stackY1_5]}
                  disabled={!csvInput.trim()}
                  onClick={applyCSV}
                >
                  Apply CSV
                </Button>
              </div>
            )}
          </div>
        </section>

        {/* Fly-by videos */}
        <section>
          <SectionHeading>Fly-by videos</SectionHeading>

          {existingVideos.length > 0 && (
            <ul className={stylex.props(styles.s_498).className}>
              {existingVideos.map((v) => (
                <li key={v.uri} className={stylex.props(styles.s_79).className}>
                  <Film className={stylex.props(styles.s_929).className} />
                  <span className={stylex.props(styles.s_81).className}>
                    {v.label ? (
                      <><span className={stylex.props(styles.s_517).className}>{v.label}</span> — </>
                    ) : null}
                    {v.uri.split("/").pop()}
                  </span>
                  <button
                    type="button"
                    onClick={() => markArtifactForDeletion(v.uri)}
                    className={stylex.props(styles.s_83).className}
                    title="Remove this video"
                    aria-label="Remove this video"
                  >
                    <X className={stylex.props(styles.s_927).className} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <input
            ref={videoInputRef}
            type="file"
            accept=".mp4,video/mp4"
            multiple
            className={stylex.props(styles.s_373).className}
            onChange={(e) => addFiles(e, setVideoEntries)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            xstyle={styles.s_288}
            onClick={() => videoInputRef.current?.click()}
          >
            <Film className={stylex.props(styles.s_121).className} />
            Add videos
          </Button>

          {videoEntries.length > 0 && (
            <div className={stylex.props(styles.s_819).className}>
              {videoEntries.map((entry) => (
                <div key={entry.id} className={stylex.props(styles.s_89).className}>
                  <Film className={stylex.props(styles.s_929).className} />
                  <span className={stylex.props(styles.s_91).className}>{entry.file.name}</span>
                  <Input
                    value={entry.label}
                    onChange={(e) => updateLabel(entry.id, e.target.value, setVideoEntries)}
                    placeholder="Label"
                    xstyle={styles.s_92}
                  />
                  <button
                    type="button"
                    onClick={() => removeEntry(entry.id, setVideoEntries)}
                    className={stylex.props(styles.s_110).className}
                  >
                    <X className={stylex.props(styles.s_927).className} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Thumbnail images */}
        <section>
          <SectionHeading>Thumbnail images</SectionHeading>

          {existingImages.length > 0 && (
            <ul className={stylex.props(styles.s_498).className}>
              {existingImages.map((img) => (
                <li key={img.uri} className={stylex.props(styles.s_79).className}>
                  <ImageIcon className={stylex.props(styles.s_929).className} aria-hidden />
                  <span className={stylex.props(styles.s_81).className}>
                    {img.label ? (
                      <><span className={stylex.props(styles.s_517).className}>{img.label}</span> — </>
                    ) : null}
                    {img.uri.split("/").pop()}
                  </span>
                  <button
                    type="button"
                    onClick={() => markArtifactForDeletion(img.uri)}
                    className={stylex.props(styles.s_83).className}
                    title="Remove this image"
                    aria-label="Remove this image"
                  >
                    <X className={stylex.props(styles.s_927).className} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <input
            ref={imageInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            multiple
            className={stylex.props(styles.s_373).className}
            onChange={(e) => addFiles(e, setImageEntries)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            xstyle={styles.s_288}
            onClick={() => imageInputRef.current?.click()}
          >
            <ImageIcon className={stylex.props(styles.s_121).className} aria-hidden />
            Add images
          </Button>

          {imageEntries.length > 0 && (
            <div className={stylex.props(styles.s_819).className}>
              {imageEntries.map((entry) => (
                <div key={entry.id} className={stylex.props(styles.s_89).className}>
                  <ImageIcon className={stylex.props(styles.s_929).className} aria-hidden />
                  <span className={stylex.props(styles.s_91).className}>{entry.file.name}</span>
                  <Input
                    value={entry.label}
                    onChange={(e) => updateLabel(entry.id, e.target.value, setImageEntries)}
                    placeholder="Label"
                    xstyle={styles.s_92}
                  />
                  <button
                    type="button"
                    onClick={() => removeEntry(entry.id, setImageEntries)}
                    className={stylex.props(styles.s_110).className}
                  >
                    <X className={stylex.props(styles.s_927).className} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 3D Digital Twin */}
        <section>
          <SectionHeading>3D Digital Twin</SectionHeading>

          {has3D && (
            <div className={stylex.props(styles.s_95).className}>
              <Box className={stylex.props(styles.s_96).className} />
              <span className={stylex.props(styles.s_97).className}>3D assets available</span>
              <button
                type="button"
                onClick={handleDelete3D}
                className={stylex.props(styles.s_98).className}
                title="Delete 3D assets"
              >
                <Trash2 className={stylex.props(styles.s_927).className} />
              </button>
            </div>
          )}

          {delete3D && (
            <div className={stylex.props(styles.s_100).className}>
              <AlertTriangle className={stylex.props(styles.s_101).className} />
              <span className={stylex.props(styles.s_102).className}>3D assets marked for removal</span>
              <button
                type="button"
                onClick={handleUndelete3D}
                className={stylex.props(styles.s_110).className}
                title="Undo removal"
              >
                <Undo2 className={stylex.props(styles.s_927).className} />
              </button>
            </div>
          )}

          {threeDFiles.length > 0 && (
            <div className={stylex.props(styles.s_105).className}>
              <FolderUp className={stylex.props(styles.s_909).className} />
              <span className={stylex.props(styles.s_107).className}>
                <span className={stylex.props(styles.s_517).className}>{threeDFiles.length}</span> files from{" "}
                <span className={stylex.props(styles.s_109).className}>
                  {threeDFiles[0]?.webkitRelativePath.split("/")[0] ?? "folder"}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setThreeDFiles([])}
                className={stylex.props(styles.s_110).className}
                title="Clear selection"
              >
                <X className={stylex.props(styles.s_927).className} />
              </button>
            </div>
          )}

          {threeDUploadProgress && (
            <div className={stylex.props(styles.s_498).className}>
              <div className={stylex.props(styles.s_113).className}>
                <div
                  className={stylex.props(styles.s_114).className}
                  style={{ width: `${Math.round((threeDUploadProgress.completed / threeDUploadProgress.total) * 100)}%` }}
                />
              </div>
              <p className={stylex.props(styles.s_539).className}>
                {threeDUploadProgress.completed}/{threeDUploadProgress.total} files
                {threeDUploadProgress.currentFile && (
                  <> — <span className={stylex.props(styles.s_940).className}>{threeDUploadProgress.currentFile}</span></>
                )}
              </p>
            </div>
          )}

          {!has3D && !delete3D && threeDFiles.length === 0 && !threeDUploadProgress && (
            <p className={stylex.props(styles.s_117).className}>
              No 3D digital twin assets. Upload a folder containing a <span className={stylex.props(styles.s_940).className}>manifest.json</span> and tile files.
            </p>
          )}

          <input
            ref={threeDInputRef}
            type="file"
            // @ts-expect-error -- webkitdirectory is a non-standard attribute
            webkitdirectory=""
            directory=""
            className={stylex.props(styles.s_373).className}
            onChange={handleThreeDFolderSelect}
          />
          {!delete3D && !threeDUploadProgress && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              xstyle={styles.s_288}
              onClick={() => threeDInputRef.current?.click()}
            >
              <FolderUp className={stylex.props(styles.s_121).className} />
              {has3D || threeDFiles.length > 0 ? "Replace 3D Folder" : "Upload 3D Folder"}
            </Button>
          )}
        </section>

        <MapAssetDangerZone
          dangerOpen={dangerOpen}
          deleteBusy={deleteBusy}
          deleteConfirmEmail={deleteConfirmEmail}
          deleteError={deleteError}
          sessionEmail={sessionEmail}
          sessionLoaded={sessionLoaded}
          submitting={submitting}
          onDeleteConfirmEmailChange={(next) => {
            setDeleteConfirmUsername(next);
            setDeleteError(null);
          }}
          onDeleteMap={handleDeleteMap}
          onToggleDangerOpen={() => setDangerOpen((o) => !o)}
        />
      </div>

      {/* Sticky footer */}
      <div className={stylex.props(styles.s_122).className}>
        {error && <p className={stylex.props(styles.s_451).className}>{error}</p>}
        <div className={stylex.props(styles.s_124).className}>
          <Button
            type="button"
            size="sm"
            disabled={submitting}
            onClick={handleSave}
            xstyle={styles.s_436}
          >
            {submitting ? "Saving…" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={onBack}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
