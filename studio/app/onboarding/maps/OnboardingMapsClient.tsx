"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  readRenderingPreference,
  saveRenderingPreference,
} from "@simforge-oss/studio-ui/components/rendering-preference";
import { MapSelectionScreen, type OnboardingMapOption } from "@simforge-oss/studio-ui/onboarding";
import { CloudAccountPanel } from "@/app/components/cloud/CloudAccountPanel";
import { useMapPreparation } from "@/app/components/map-preparation/useMapPreparation";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
import { completeStudioSetup } from "@/app/lib/host/setup";
import {
  DEFAULT_SCENARIO_AUTHORING_QUALITY_ID,
  type ScenarioAuthoringQuality,
} from "@/app/lib/scenario/contracts";
import { inlineSignIn } from "../onboarding-layout.stylex";

const NATIVE_RENDER_PATH = "/onboarding/native-render";

const CatalogSchema = z.object({
  maps: z.array(
    z.object({
      mapVersionId: z.string().min(1),
      label: z.string().min(1),
      locality: z.string().nullable(),
      thumbnailUrl: z.string().nullable(),
      browserManifestUrl: z.string().nullable(),
      access: z.enum(["public", "local", "cloud"]),
      locked: z.boolean(),
      closureBytes: z.object({ browser: z.number(), semantic: z.number() }).nullable(),
    }),
  ),
  upstream: z.discriminatedUnion("reachable", [
    z.object({ reachable: z.literal(true) }),
    z.object({ reachable: z.literal(false), message: z.string() }),
  ]),
});

const CacheStatusSchema = z.object({ availableBytes: z.number().nullable() });

/**
 * Step 2: which maps to download now, at which graphics level, and the
 * completion of first-run setup.
 *
 * The installs are host jobs, so this page is safe to leave: a relaunch lands
 * here again (the setup row is still incomplete) and `useMapPreparation`
 * rejoins whatever is still running instead of starting over.
 */
export function OnboardingMapsClient() {
  const router = useRouter();
  const cloud = useStudioCloudStatus();
  const [maps, setMaps] = useState<OnboardingMapOption[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>(
    DEFAULT_SCENARIO_AUTHORING_QUALITY_ID,
  );
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [revealSignIn, setRevealSignIn] = useState(false);
  const finishing = useRef(false);
  const preparation = useMapPreparation({ mapVersionIds: selection });
  const cloudState = cloud.status?.state ?? null;
  const signedIn = cloudState === "connected";
  // Signed in, every published map is already selectable; the flow would have
  // nothing left to unlock.
  const signingIn = revealSignIn && !signedIn;
  const started = preparation.phase !== "idle";

  useEffect(() => setQuality(readRenderingPreference() ?? DEFAULT_SCENARIO_AUTHORING_QUALITY_ID), []);

  useEffect(() => {
    // A download in flight owns the list it started with.
    if (started) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch("/api/simforge/maps/catalog", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`The map catalog could not be loaded (${response.status}).`);
      const catalog = CatalogSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      const available = catalog.maps
        .filter((map) => Boolean(map.browserManifestUrl))
        .map<OnboardingMapOption>((map) => ({
          mapVersionId: map.mapVersionId,
          label: map.label,
          locality: map.locality,
          thumbnailUrl: map.thumbnailUrl,
          // A `semantic` install pulls the browser closure too, which is what
          // the install's own progress total counts, so the card shows the sum
          // rather than a number half the size of the download it starts.
          bytes: map.closureBytes ? map.closureBytes.browser + map.closureBytes.semantic : null,
          locked: map.locked,
          // The Cloud's public map (Richmond Field Station) is part of every
          // installation: listed as included, never offered as a choice.
          required: map.access === "public",
        }));
      setMaps(available);
      // Everything this installation may download is pre-selected: locally
      // that is Richmond Field Station, signed in it is the whole library.
      // A selection the user already made survives a catalog refresh, but
      // the required maps are always in it.
      setSelection((current) => {
        const required = available.filter((map) => map.required).map((map) => map.mapVersionId);
        if (current.length === 0) return available.filter((map) => !map.locked).map((map) => map.mapVersionId);
        return [...current, ...required.filter((id) => !current.includes(id))];
      });
      setCatalogError(catalog.upstream.reachable ? null : catalog.upstream.message);
      setError(null);
      setLoading(false);
    })().catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "The map catalog could not be loaded.");
      setLoading(false);
    });
    return () => controller.abort();
    // Signing in adds the account's maps, which the list has to pick up.
  }, [cloudState, started]);

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
  }, []);

  useEffect(() => {
    if (preparation.phase !== "complete" || finishing.current) return;
    finishing.current = true;
    void completeStudioSetup({ mode: signedIn ? "cloud" : "local", quality })
      .then(() => router.replace(NATIVE_RENDER_PATH))
      .catch((reason: unknown) => {
        finishing.current = false;
        setError(reason instanceof Error ? reason.message : "Setup could not be completed.");
      });
  }, [preparation.phase, signedIn, quality, router]);

  return (
    <MapSelectionScreen
      catalogError={catalogError}
      // The revealed flow reports its own failures, so only this page's
      // catalog and setup errors go to the screen while it is open.
      error={error ?? (signingIn ? null : cloud.error)}
      freeBytes={freeBytes}
      loading={loading}
      maps={maps}
      onCancelSignIn={cloudState === "connecting" ? undefined : () => setRevealSignIn(false)}
      onDownload={() => {
        // The viewer reads the level from browser storage; save it before the
        // first map lands so a mid-download navigation already renders right.
        saveRenderingPreference(quality);
        preparation.start();
      }}
      onQualityChange={setQuality}
      onRetry={preparation.retry}
      onSignIn={() => setRevealSignIn(true)}
      onSkip={preparation.skip}
      onToggle={(mapVersionId) =>
        setSelection((current) => {
          if (maps.some((map) => map.mapVersionId === mapVersionId && map.required)) return current;
          return current.includes(mapVersionId)
            ? current.filter((id) => id !== mapVersionId)
            : [...current, mapVersionId];
        })
      }
      preparation={preparation}
      quality={quality}
      selection={selection}
      signedIn={signedIn}
      signIn={signingIn ? <CloudAccountPanel xstyle={inlineSignIn.panel} /> : undefined}
    />
  );
}
