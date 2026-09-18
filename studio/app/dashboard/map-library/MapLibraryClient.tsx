"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import {
  HeroFlowShell,
  MapLibraryScreen,
  type MapLibraryMap,
} from "@simforge-oss/studio-ui/onboarding";
import { CloudAccountPanel } from "@/app/components/cloud/CloudAccountPanel";
import { useMapPreparation } from "@/app/components/map-preparation/useMapPreparation";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
// The library is a screen of the hero flow, so it composes the account panel
// exactly the way the onboarding sign-in step does.
import { inlineSignIn } from "@/app/onboarding/onboarding-layout.stylex";

const CatalogSchema = z.object({
  maps: z.array(
    z.object({
      mapVersionId: z.string().min(1),
      label: z.string().min(1),
      locality: z.string().nullable(),
      thumbnailUrl: z.string().nullable(),
      browserManifestUrl: z.string().nullable(),
      locked: z.boolean(),
      installed: z.object({ browser: z.boolean(), semantic: z.boolean() }),
      closureBytes: z.object({ browser: z.number(), semantic: z.number() }).nullable(),
    }),
  ),
  upstream: z.discriminatedUnion("reachable", [
    z.object({ reachable: z.literal(true) }),
    z.object({ reachable: z.literal(false), message: z.string() }),
  ]),
});

const CacheStatusSchema = z.object({ availableBytes: z.number().nullable() });

type CatalogMap = z.infer<typeof CatalogSchema>["maps"][number];

/**
 * The map library: the persistent surface for installing maps, over the same
 * hero and in the same column as first-run setup.
 *
 * It shares the host plumbing with that step rather than repeating it — one
 * catalog endpoint, one install endpoint, one {@link useMapPreparation} loop —
 * and differs in exactly two ways, which are the reasons it exists: maps are
 * installed one at a time on demand instead of as one queued batch, and
 * finishing installs nothing else. Setup completion belongs to onboarding; a
 * user who adds a map two months later is not being onboarded.
 */
export function MapLibraryClient() {
  const cloud = useStudioCloudStatus();
  const [catalog, setCatalog] = useState<CatalogMap[]>([]);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  /** The maps this page asked the host to install, in this visit. */
  const [requested, setRequested] = useState<string[]>([]);
  const [revealSignIn, setRevealSignIn] = useState(false);
  const cloudState = cloud.status?.state ?? null;
  const signedIn = cloudState === "connected";
  const signingIn = revealSignIn && !signedIn;
  // Every map that has a browser closure to install, locked ones included:
  // signing in must not have to rebuild the loop's row list.
  const installable = catalog.filter((map) => Boolean(map.browserManifestUrl));
  const preparation = useMapPreparation({
    mapVersionIds: installable.filter((map) => !map.locked).map((map) => map.mapVersionId),
  });

  // The catalog carries what is installed, so it is re-read when an install
  // settles as well as when the session changes: the difference between the
  // two is exactly what a user comes to this page to see.
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
      setCatalog(body.maps);
      setCatalogError(body.upstream.reachable ? null : body.upstream.message);
      setError(null);
      setLoading(false);
    })().catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "The map catalog could not be loaded.");
      setLoading(false);
    });
    return () => controller.abort();
  }, [cloudState, preparation.phase]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch("/api/simforge/map-cache/status", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return;
      const status = CacheStatusSchema.parse(await response.json());
      if (!controller.signal.aborted) setFreeBytes(status.availableBytes);
    })().catch(() => {
      // Free space is advisory here; the cache enforces its own limit.
    });
    return () => controller.abort();
  }, [preparation.phase]);

  const maps = installable.map<MapLibraryMap>((map) => {
    const row = preparation.maps.find((candidate) => candidate.mapVersionId === map.mapVersionId);
    // The loop keeps a row for every map it *could* install, so a row alone
    // says nothing: a card reports an install only when this page asked for
    // one, or when the host turns out to be running (or to have failed) one
    // anyway — an install left behind by an earlier window.
    const live = row !== undefined
      && (requested.includes(map.mapVersionId) || row.state === "installing" || row.state === "error");
    return {
      mapVersionId: map.mapVersionId,
      label: map.label,
      locality: map.locality,
      thumbnailUrl: map.thumbnailUrl,
      // A `semantic` install transfers the browser closure too, so the size
      // on the card is the size of what the button is about to do.
      bytes: map.closureBytes ? map.closureBytes.browser + map.closureBytes.semantic : null,
      locked: map.locked,
      // An install that just finished is installed before the catalog has
      // been read again; the row is the fresher of the two facts.
      installed: (map.installed.browser && map.installed.semantic) || row?.state === "ready",
      install: live ? row : null,
    };
  });

  return (
    <HeroFlowShell as="section" fill>
      <MapLibraryScreen
        catalogError={catalogError}
        // The revealed flow reports its own failures, so only this page's
        // catalog errors go to the screen while it is open.
        error={error ?? (signingIn ? null : cloud.error)}
        freeBytes={freeBytes}
        loading={loading}
        maps={maps}
        onCancelSignIn={cloudState === "connecting" ? undefined : () => setRevealSignIn(false)}
        onInstall={(mapVersionId) => {
          setRequested((current) =>
            current.includes(mapVersionId) ? current : [...current, mapVersionId],
          );
          preparation.install(mapVersionId);
        }}
        onSignIn={() => setRevealSignIn(true)}
        signedIn={signedIn}
        signIn={signingIn ? <CloudAccountPanel xstyle={inlineSignIn.panel} /> : undefined}
      />
    </HeroFlowShell>
  );
}
