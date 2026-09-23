"use client";

import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import type { ScenarioMapPinStatusDto, ScenarioMapRepinPreviewDto } from "@simforge-oss/studio-host";

import { Button } from "../../../components/ui/button";
import { Chip } from "../../../components/ui/chip";
import { Dot } from "../../../components/ui/dot";
import { Spinner } from "../../../components/ui/spinner";
import { useStudioHost } from "../../../host";
import { hairline, surface, typography } from "../../../stylex/recipes.stylex";
import { diffChip, shortDate } from "./versions-model";
import { styles } from "./versions.stylex";

const PREVIEW_WAIT_MS = 20_000;
const PREVIEW_ATTEMPTS = 6;

/**
 * OWNS: "a newer map is available". A draft stays on the map version it is pinned to; a newer
 * publication of the same map is offered, never applied. Preview simulates the draft on the newer
 * version and shows how its motion would change; only "Move" re-pins (`onMove`).
 */
export function NewerMapBanner({
  documentId,
  mapVersionId,
  onMove,
}: {
  documentId: string | null;
  mapVersionId: string | null;
  onMove: (targetMapVersionId: string) => Promise<void>;
}) {
  const studioHost = useStudioHost();
  const [status, setStatus] = useState<ScenarioMapPinStatusDto | null>(null);
  const [preview, setPreview] = useState<ScenarioMapRepinPreviewDto | null>(null);
  const [busy, setBusy] = useState<"preview" | "move" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setStatus(null);
    setPreview(null);
    setDismissed(false);
    if (!documentId || !mapVersionId) return;
    const abort = new AbortController();
    studioHost.projects.getMapPinStatus(documentId, abort.signal)
      .then(setStatus)
      .catch(() => undefined);
    return () => abort.abort();
  }, [documentId, mapVersionId, studioHost]);

  if (!documentId || !status?.newer || dismissed) return null;
  const newer = status.newer;
  const pinnedDate = shortDate(status.pinned?.publishedAt);
  const chip = preview ? diffChip(preview.motionDiff, preview.status.state === "succeeded") : null;

  const runPreview = async () => {
    setBusy("preview");
    setError(null);
    try {
      for (let attempt = 0; attempt < PREVIEW_ATTEMPTS; attempt += 1) {
        const next = await studioHost.projects.previewMapRepin(documentId, { targetMapVersionId: newer.mapVersionId, waitMs: PREVIEW_WAIT_MS });
        setPreview(next);
        if (next.status.state === "failed") throw new Error(next.status.message ?? next.status.failureCode);
        if (next.status.state === "succeeded") return;
      }
      throw new Error("The preview simulation is still queued; try again in a moment.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const move = async () => {
    setBusy("move");
    setError(null);
    try {
      await onMove(newer.mapVersionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(null);
    }
  };

  return (
    <section {...stylex.props(surface.raised, hairline.all, styles.banner)} aria-labelledby="newer-map-title" data-testid="newer-map-banner">
      <Dot tone="accent" />
      <div {...stylex.props(styles.bannerText)}>
        <h2 {...stylex.props(typography.label, styles.bannerHeading)} id="newer-map-title">
          Newer map available: {newer.name} · {shortDate(newer.publishedAt)}
        </h2>
        <p {...stylex.props(typography.bodySm, styles.bannerBody)}>
          This scenario stays on {status.pinned?.name ?? "its map"}{pinnedDate ? ` · ${pinnedDate}` : ""}
          {status.pinned?.retired ? " (retired, still simulated as pinned)" : ""} until you move it. Moving re-simulates it on the new map.
        </p>
        {chip ? <span><Chip tone={chip.tone} title={chip.title} data-testid="newer-map-diff">On the new map: {chip.text}</Chip></span> : null}
        {error ? <p {...stylex.props(typography.bodySm, styles.bannerBody)} role="alert">{error}</p> : null}
      </div>
      <div {...stylex.props(styles.bannerActions)}>
        {preview?.status.state === "succeeded" ? (
          <Button data-testid="newer-map-move" disabled={busy !== null} onClick={() => void move()} size="sm" variant="accent">
            {busy === "move" ? <Spinner size="sm" tone="onAccent" /> : null}
            Move to {shortDate(newer.publishedAt)}
          </Button>
        ) : (
          <Button data-testid="newer-map-preview" disabled={busy !== null} onClick={() => void runPreview()} size="sm" variant="outline">
            {busy === "preview" ? <Spinner size="sm" /> : null}
            Preview the move
          </Button>
        )}
        <Button disabled={busy !== null} onClick={() => setDismissed(true)} size="sm" variant="ghost">
          Not now
        </Button>
      </div>
    </section>
  );
}
