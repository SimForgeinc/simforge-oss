"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import {
  MapLibraryScreen,
  type MapLibraryMap,
} from "@simforge-oss/studio-ui/onboarding";
import { CloudLoadingSurface } from "@simforge-oss/studio-ui/components/CloudLoadingSurface";
import { AppStage } from "@/app/components/AppStage";

/**
 * The map library on a cloud host: what this workspace can open.
 *
 * The page survives because the catalog does — the deployment publishes maps
 * and this is where you see all of them, with their locality and thumbnail,
 * including the ones a plan does not unlock. What does not survive is
 * residency: there is no disk to install a closure on, no download size to
 * weigh against free space, and no "installed on this computer" to report,
 * because every client streams the same objects. The screen is therefore
 * mounted in its read-only catalog mode.
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

export function MapLibrarySurface() {
  const [maps, setMaps] = useState<MapLibraryMap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch("/api/simforge/maps/catalog", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`The map catalog could not be loaded (${response.status}).`);
      const body = CatalogSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      setMaps(
        body.maps
          .filter((map) => Boolean(map.browserManifestUrl))
          .map((map) => ({
            mapVersionId: map.mapVersionId,
            label: map.label,
            locality: map.locality,
            thumbnailUrl: map.thumbnailUrl,
            // Residency facts a host with no disk cannot have.
            bytes: null,
            locked: map.locked,
            installed: false,
            install: null,
          })),
      );
      setCatalogError(body.upstream.reachable ? null : body.upstream.message);
      setError(null);
      setLoading(false);
    })().catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "The map catalog could not be loaded.");
      setLoading(false);
    });
    return () => controller.abort();
  }, [retry]);

  return (
    <AppStage fill title="Maps in this workspace" eyebrow="Map library" testId="map-library-stage">
      {loading && maps.length === 0 ? <CloudLoadingSurface scope="screen" title="Loading the map catalog" /> : null}
      <MapLibraryScreen
        catalog
        catalogError={catalogError}
        onRetry={() => { setLoading(true); setRetry((value) => value + 1); }}
        error={error}
        freeBytes={null}
        loading={loading}
        maps={maps}
        // Read-only: no install queue, and the account is the session you are
        // already in, so neither control is reachable.
        onInstall={() => undefined}
        onSignIn={() => undefined}
        signedIn
      />
    </AppStage>
  );
}
