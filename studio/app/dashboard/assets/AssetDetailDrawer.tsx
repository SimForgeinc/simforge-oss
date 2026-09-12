"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { AlertTriangle, Check, Clipboard, Loader2, Pencil, Trash2 } from "lucide-react";
import { CarlaCompatibilityPill } from "@simforge-oss/studio-ui/components/CarlaCompatibilityPill";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@simforge-oss/studio-ui/components/ui/sheet";
import type { GalleryAssetSummary } from "@simforge-oss/studio-ui/lib/asset-gallery/contracts";
import { dialog, drawer } from "./asset-dialogs.stylex";
import { GALLERY_UPLOAD_CARLA_COMPATIBILITY } from "./gallery-filters";

/**
 * Loaded on demand, and the one place in this page where that is warranted: the
 * preview pulls three.js and a GLB loader, which is most of the route's weight
 * and is only ever needed once a visitor opens a specific asset.
 */
const AssetModelPreview = dynamic(() => import("./AssetModelPreview"), {
  ssr: false,
  loading: () => (
    <div {...stylex.props(dialog.loadingPreview)}>
      Loading preview…
    </div>
  ),
});

/**
 * How many scenarios place this model.
 *
 * The count is an informative warning shown at the instant someone presses
 * Delete, never a gate: a lookup that fails or never answers must not strand a
 * moderator in front of a button that will not fire, so `unknown` still allows
 * the removal — it just does so without the number.
 */
type UsageState =
  | { phase: "loading" }
  | { phase: "known"; scenarioCount: number }
  | { phase: "unknown" };

export function AssetDetailDrawer({
  asset,
  onClose,
  onDeleted,
  onRenamed,
}: {
  asset: GalleryAssetSummary | null;
  onClose: () => void;
  onDeleted: (assetId: string) => void;
  onRenamed: (asset: GalleryAssetSummary) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  /** `null` while not renaming, so an empty draft stays distinct from closed. */
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [usage, setUsage] = useState<UsageState>({ phase: "loading" });
  const [error, setError] = useState<string | null>(null);

  const assetId = asset?.assetId ?? null;

  // A drawer showing a different asset must not inherit the previous one's
  // armed confirmation or half-typed rename.
  useEffect(() => {
    setConfirmingDelete(false);
    setRenameDraft(null);
    setError(null);
  }, [assetId]);

  useEffect(() => {
    if (!confirmingDelete || !assetId) return;
    const abort = new AbortController();
    setUsage({ phase: "loading" });
    void fetch(`/api/asset-gallery/${assetId}/usage`, { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Usage lookup failed (${response.status}).`);
        return (await response.json()) as { scenarioCount?: unknown };
      })
      .then((body) => {
        setUsage(
          typeof body.scenarioCount === "number"
            ? { phase: "known", scenarioCount: body.scenarioCount }
            : { phase: "unknown" },
        );
      })
      .catch(() => {
        if (!abort.signal.aborted) setUsage({ phase: "unknown" });
      });
    return () => abort.abort();
  }, [confirmingDelete, assetId]);

  const copyCatalogId = async () => {
    if (!asset) return;
    await navigator.clipboard.writeText(asset.catalogId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const deleteAsset = async () => {
    if (!asset) return;
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/asset-gallery/${asset.assetId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "The asset could not be deleted.");
      }
      onDeleted(asset.assetId);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The asset could not be deleted.");
    } finally {
      setDeleting(false);
    }
  };

  /**
   * Rename in place. The catalog id is deliberately untouched, so every scenario
   * already bound to this asset keeps working - the name is presentation.
   */
  const renameAsset = async () => {
    const next = renameDraft?.trim();
    if (!asset || !next || next === asset.title) {
      setRenameDraft(null);
      return;
    }
    setRenaming(true);
    setError(null);
    try {
      const response = await fetch(`/api/asset-gallery/${asset.assetId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (!response.ok) throw new Error("The asset could not be renamed.");
      const body = (await response.json()) as { asset: GalleryAssetSummary };
      onRenamed(body.asset);
      setRenameDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The asset could not be renamed.");
    } finally {
      setRenaming(false);
    }
  };

  return (
    <Sheet open={asset !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent {...stylex.props(drawer.root, dialog.detailSheet)}>
        {asset ? (
          <div {...stylex.props(drawer.root)}>
            <SheetHeader>
          <SheetTitle {...stylex.props(dialog.drawerTitle)}>{asset.title}</SheetTitle>
              <SheetDescription>
                Imported {new Date(asset.createdAt).toLocaleDateString()} · version {asset.version}
              </SheetDescription>
            </SheetHeader>

            <AssetModelPreview catalogId={asset.catalogId} />
            <div {...stylex.props(drawer.stats)}>
              <div {...stylex.props(drawer.tile)}>
                <p {...stylex.props(drawer.eyebrow)}>Class</p><p {...stylex.props(drawer.value)}>{asset.actorClass.replaceAll("_", " ")}</p>
              </div>
              <div {...stylex.props(drawer.tile)}>
                <p {...stylex.props(drawer.eyebrow)}>Triangles</p><p {...stylex.props(drawer.value)}>{asset.triangleCount.toLocaleString()}</p>
              </div>
              <div {...stylex.props(drawer.tile)}>
                <p {...stylex.props(drawer.eyebrow)}>Dimensions</p><p {...stylex.props(drawer.value)}>{asset.dims.l.toFixed(2)} × {asset.dims.w.toFixed(2)} × {asset.dims.h.toFixed(2)} m</p>
              </div>
              <div {...stylex.props(drawer.tile)}>
                <p {...stylex.props(drawer.eyebrow)}>Source</p><p {...stylex.props(drawer.value)}>{asset.sourceFormat} · {(asset.byteLength / 1_048_576).toFixed(1)} MB</p>
              </div>
              <div {...stylex.props(drawer.tile, dialog.span2)}>
                <p {...stylex.props(drawer.eyebrow)}>CARLA</p>
                <div {...stylex.props(drawer.section)}>
                  <CarlaCompatibilityPill compatibility={GALLERY_UPLOAD_CARLA_COMPATIBILITY} size="sm" />
                  <p {...stylex.props(dialog.mutedText)}>Runs in browser preview and browser-recorded renders, but not CARLA renders because it has no runtime blueprint.</p>
                </div>
              </div>
            </div>

            {asset.description ? (
              <p {...stylex.props(dialog.bodyText)}>{asset.description}</p>
            ) : null}

            {asset.tags.length > 0 ? (
              <div {...stylex.props(dialog.tagList)}>
                {asset.tags.map((tag) => <span key={tag} {...stylex.props(dialog.tag)}>{tag}</span>)}
              </div>
            ) : null}

            <section aria-labelledby="asset-clips-heading" {...stylex.props(drawer.section)}>
              <h3 id="asset-clips-heading" {...stylex.props(dialog.sectionHeading)}>Animation clips</h3>
              {asset.clips.length > 0 ? (
                <ul {...stylex.props(dialog.list)}>
                  {asset.clips.map((clip) => (
                    <li key={clip} {...stylex.props(dialog.listRow)}>
                      <span>{clip}</span>
                      <span {...stylex.props(dialog.mutedText)}>{clip === asset.idleClip ? "Idle" : clip === asset.locomotionClip ? "Locomotion" : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : <p {...stylex.props(dialog.bodyText)}>No animation clips</p>}
            </section>

            <div {...stylex.props(dialog.stack)}>
              <p {...stylex.props(dialog.mono)}>{asset.catalogId}</p>
              {renameDraft !== null ? (
                <form
                  {...stylex.props(dialog.renameForm)}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void renameAsset();
                  }}
                >
                  <Input
                    aria-label="Asset title"
                    autoFocus
                    maxLength={120}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    {...stylex.props(dialog.inputCompact)}
                  />
                  <Button type="submit" size="sm" {...stylex.props(dialog.buttonCompact)} disabled={renaming || renameDraft.trim() === ""}>
                    {renaming ? <Loader2 aria-hidden="true" {...stylex.props(dialog.progressPulse)} /> : null}
                    {renaming ? "Saving…" : "Save title"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    {...stylex.props(dialog.buttonCompact)}
                    disabled={renaming}
                    onClick={() => setRenameDraft(null)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : confirmingDelete ? (
                <div
                  role="group"
                  aria-labelledby="asset-delete-heading"
                  {...stylex.props(dialog.deleteBox)}
                >
                  <p id="asset-delete-heading" {...stylex.props(dialog.deleteHeading)}>
                    Remove “{asset.title}” from the local library?
                  </p>

                  {usage.phase === "loading" ? (
                    <p {...stylex.props(dialog.usageLoading)}>
                      <Loader2 aria-hidden="true" {...stylex.props(dialog.usageIcon, dialog.progressPulse)} />
                      Checking which scenarios use it…
                    </p>
                  ) : usage.phase === "known" && usage.scenarioCount > 0 ? (
                    <p {...stylex.props(dialog.usageWarning)}>
                      <AlertTriangle aria-hidden="true" {...stylex.props(dialog.usageWarningIcon)} />
                      Used by {usage.scenarioCount} {usage.scenarioCount === 1 ? "scenario" : "scenarios"}
                    </p>
                  ) : usage.phase === "known" ? (
                    <p {...stylex.props(dialog.usageNote)}>No scenario places this model.</p>
                  ) : (
                    <p {...stylex.props(dialog.usageNote)}>
                      Scenario usage could not be checked, so remove this one with care.
                    </p>
                  )}


                  <div {...stylex.props(dialog.deleteActions)}>
                    <Button type="button" size="sm" variant="destructive" disabled={deleting} onClick={() => void deleteAsset()}>
                      {deleting ? <Loader2 aria-hidden="true" {...stylex.props(dialog.progressPulse)} /> : <Trash2 aria-hidden="true" />}
                      {deleting ? "Removing…" : "Remove asset"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={deleting}
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Keep it
                    </Button>
                  </div>
                </div>
              ) : (
                <div {...stylex.props(drawer.actions)}>
                  <Button type="button" size="sm" variant="outline" onClick={() => void copyCatalogId()}>
                    {copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
                    {copied ? "Copied" : "Copy catalog ID"}
                  </Button>
                  {/* Renaming is owner-only on purpose. Removal is destructive but
                      soft and attributed, so open moderation carries it; rewriting
                      another author's label leaves no such trace, and the API
                      refuses it regardless. */}
                  {asset.ownedByViewer ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => setRenameDraft(asset.title)}>
                      <Pencil aria-hidden="true" /> Rename
                    </Button>
                  ) : null}
                  <Button type="button" size="sm" variant="destructive" onClick={() => setConfirmingDelete(true)}>
                    <Trash2 aria-hidden="true" /> Delete
                  </Button>
                </div>
              )}

              {error ? (
                <p role="alert" {...stylex.props(dialog.errorDanger)}>{error}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
