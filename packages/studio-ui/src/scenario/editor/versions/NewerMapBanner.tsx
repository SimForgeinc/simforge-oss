"use client";

import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import type { ScenarioMapPinStatusDto } from "@simforge-oss/studio-host";

import { Button } from "../../../components/ui/button";
import { Dot } from "../../../components/ui/dot";
import { useStudioHost } from "../../../host";
import { hairline, surface, typography } from "../../../stylex/recipes.stylex";
import { MapTransitionDialog } from "./MapTransitionDialog";
import { shortDate } from "./versions-model";
import { styles } from "./versions.stylex";

/**
 * OWNS: "Newer map version available". A draft stays on the map version it is pinned to; a newer
 * publication of the same map is offered, never applied. "Review the move" opens the transition
 * view; moving keeps the state before the move as a version. `notice` reports a finished move.
 */
export function NewerMapBanner({
  documentId,
  mapVersionId,
  notice,
  onMove,
}: {
  documentId: string | null;
  mapVersionId: string | null;
  notice?: string | null;
  onMove: (targetMapVersionId: string) => Promise<void>;
}) {
  const studioHost = useStudioHost();
  const [status, setStatus] = useState<ScenarioMapPinStatusDto | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setStatus(null);
    setDismissed(false);
    if (!documentId || !mapVersionId) return;
    const abort = new AbortController();
    studioHost.projects.getMapPinStatus(documentId, abort.signal)
      .then(setStatus)
      .catch(() => undefined);
    return () => abort.abort();
  }, [documentId, mapVersionId, studioHost]);

  if (notice) {
    return (
      <section {...stylex.props(surface.raised, hairline.all, styles.banner)} data-testid="map-move-notice" role="status">
        <Dot tone="positive" />
        <p {...stylex.props(typography.bodySm, styles.bannerBody)}>{notice}</p>
      </section>
    );
  }
  if (!documentId || !status?.newer || dismissed) return null;
  const newer = status.newer;
  const pinnedDate = shortDate(status.pinned?.publishedAt);

  return (
    <section {...stylex.props(surface.raised, hairline.all, styles.banner)} aria-labelledby="newer-map-title" data-testid="newer-map-banner">
      <Dot tone="accent" />
      <div {...stylex.props(styles.bannerText)}>
        <h2 {...stylex.props(typography.label, styles.bannerHeading)} id="newer-map-title">
          Newer map version available: {newer.name} · {shortDate(newer.publishedAt)}
        </h2>
        <p {...stylex.props(typography.bodySm, styles.bannerBody)}>
          This scenario stays on {status.pinned?.name ?? "its map"}{pinnedDate ? ` · ${pinnedDate}` : ""}
          {status.pinned?.retired ? " (retired, still simulated as pinned)" : ""} until you move it.
        </p>
      </div>
      <div {...stylex.props(styles.bannerActions)}>
        <Button data-testid="newer-map-review" onClick={() => setReviewing(true)} size="sm" variant="outline">
          Review the move
        </Button>
        <Button onClick={() => setDismissed(true)} size="sm" variant="ghost">
          Not now
        </Button>
      </div>
      <MapTransitionDialog
        documentId={documentId}
        targetMapVersionId={newer.mapVersionId}
        open={reviewing}
        onClose={() => setReviewing(false)}
        onMove={onMove}
      />
    </section>
  );
}
