"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { MapDownloadsPanel, type MapDownloadsCatalogMap } from "@simforge-oss/studio-ui/map-downloads";
import type { MapDownloadsProps } from "@/app/host/contract";

/**
 * Map Downloads on a cloud host: the workspace's maps, downloaded into THIS
 * browser's map cache at the chosen render setting.
 *
 * It replaces the read-only "Map availability" page. The catalog is the same
 * one that page listed; what is new is residency: a hosted deployment has no
 * disk of its own, but the browser does, and a map whose files are already in
 * its cache opens without waiting on the network. Every map the catalog lists
 * is shown, including the ones a plan does not unlock (as locked) and the ones
 * without a browser bundle (as unavailable, with the reason) — nothing is left
 * out of the list silently.
 */

const CatalogSchema = z.object({
  maps: z.array(
    z.object({
      mapVersionId: z.string().min(1),
      label: z.string().min(1),
      locality: z.string().nullable(),
      thumbnailUrl: z.string().nullable(),
      browserManifestUrl: z.string().nullable(),
      locked: z.boolean(),
    }),
  ),
  upstream: z.discriminatedUnion("reachable", [
    z.object({ reachable: z.literal(true) }),
    z.object({ reachable: z.literal(false), message: z.string() }),
  ]),
});

export function MapDownloads({ firstRun }: MapDownloadsProps) {
  const [maps, setMaps] = useState<MapDownloadsCatalogMap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch("/api/simforge/maps/catalog", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`The map catalog could not be loaded (${response.status}).`);
      const body = CatalogSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      setMaps(body.maps.map((map) => ({
        mapVersionId: map.mapVersionId,
        label: map.label,
        locality: map.locality,
        thumbnailUrl: map.thumbnailUrl,
        locked: map.locked,
      })));
      setError(body.upstream.reachable ? null : body.upstream.message);
      setLoading(false);
    })().catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "The map catalog could not be loaded.");
      setLoading(false);
    });
    return () => controller.abort();
  }, [retry]);

  return (
    <MapDownloadsPanel
      maps={maps}
      loading={loading}
      error={error}
      firstRun={firstRun}
      onRetry={() => { setLoading(true); setRetry((value) => value + 1); }}
    />
  );
}
