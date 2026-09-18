import { useEffect, useState } from "react";
import { z } from "zod";
import { isCityAssetVariantManifest, supportsCityAssetVariant } from "@simforge-oss/viewer/asset-variants";
import { useStudioHost } from "../host";
import { useRenderingBenchmarkTarget } from "./rendering-benchmark-target";
import {
  SCENARIO_AUTHORING_QUALITY_IDS,
  type ScenarioAuthoringQuality,
} from "../lib/scenario/contracts";

export const RENDERING_PREFERENCE_STORAGE_KEY =
  "simforge.rendering-preference.v1";

export const OPEN_RENDERING_PREFERENCE_EVENT =
  "simforge:open-rendering-preference";
export const RENDERING_PREFERENCE_CHANGE_EVENT =
  "simforge:rendering-preference-change";

export type RenderingPreference = ScenarioAuthoringQuality;

function isRenderingPreference(value: unknown): value is RenderingPreference {
  return SCENARIO_AUTHORING_QUALITY_IDS.some((quality) => quality === value);
}

export function usesLightweightRendering(preference: RenderingPreference): boolean {
  return preference !== "high";
}

export function readRenderingPreference(
  storage?: Pick<Storage, "getItem"> | null,
): RenderingPreference | null {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    if (!browserStorage) return null;
    const stored = browserStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY);
    return isRenderingPreference(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function saveRenderingPreference(
  preference: RenderingPreference,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    browserStorage?.setItem(RENDERING_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // The current session can still use the selection when browser storage is
    // disabled. A future visit will ask again because it cannot be persisted.
  }
  if (storage === undefined && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<RenderingPreference>(RENDERING_PREFERENCE_CHANGE_EVENT, {
        detail: preference,
      }),
    );
  }
}

/** Ask the dashboard-level gate to reopen the same chooser used on first run. */
export function requestRenderingPreferenceSelection(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_RENDERING_PREFERENCE_EVENT));
}

/**
 * The saved preference, kept current as any surface changes it. `null` until
 * the user has chosen one; callers that render fall back to `"high"`.
 */
export function useRenderingPreference(): RenderingPreference | null {
  const [preference, setPreference] = useState<RenderingPreference | null>(readRenderingPreference);
  useEffect(() => {
    const onChange = (event: Event) => setPreference((event as CustomEvent<RenderingPreference>).detail);
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onChange);
  }, []);
  return preference;
}

export type RenderingAvailability = {
  checking: boolean;
  unavailable: Partial<Record<RenderingPreference, string>>;
};

const CHECKING_RENDERING: RenderingAvailability = {
  checking: true,
  unavailable: {
    "roads-only": "Checking the release's Roads Only derivatives…",
    "ultra-low-3d": "Checking the release's Low derivatives…",
  },
};
const RenderSources = z.object({
  staticLayers: z.array(z.object({ id: z.string(), file: z.string().min(1) })).optional(),
  tiles: z.array(z.object({ lods: z.array(z.object({ file: z.string().min(1) })) })),
});

/** Intersection for a global preference; a current map is passed as a singleton. */
export async function readRenderingAvailability(
  maps: readonly { manifestUrl: string; label: string }[],
  signal?: AbortSignal,
): Promise<RenderingAvailability> {
  if (maps.length === 0) return {
    checking: false,
    unavailable: {
      "roads-only": "Install a map to check its Roads Only derivatives.",
      "ultra-low-3d": "Install a map to check its Low derivatives.",
    },
  };
  const checked = await Promise.all(maps.map(async (map) => {
    const manifestUrl = new URL(map.manifestUrl, window.location.href);
    try {
      const [sourceResponse, variantsResponse] = await Promise.all([
        fetch(manifestUrl, { signal }),
        fetch(new URL("variants/manifest.json", manifestUrl), { signal }),
      ]);
      if (!sourceResponse.ok || !variantsResponse.ok) throw new Error("unavailable manifest");
      const source = RenderSources.parse(await sourceResponse.json());
      const value: unknown = await variantsResponse.json();
      const variants = isCityAssetVariantManifest(value) ? value : null;
      return {
        label: map.label,
        verified: true,
        roads: supportsCityAssetVariant(source, variants, "roads-only"),
        low: supportsCityAssetVariant(source, variants, "geometry-only"),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { label: map.label, roads: false, low: false, verified: false };
    }
  }));
  const roads = checked.find((map) => !map.roads);
  const low = checked.find((map) => !map.low);
  return {
    checking: false,
    unavailable: {
      ...(roads ? { "roads-only": roads.verified
        ? `${roads.label}'s installed release does not provide a complete Roads Only derivative.`
        : `${roads.label}'s derivatives could not be verified. Roads Only is unavailable.` } : {}),
      ...(low ? { "ultra-low-3d": low.verified
        ? `${low.label}'s installed release does not provide complete texture-free Low derivatives.`
        : `${low.label}'s derivatives could not be verified. Low is unavailable.` } : {}),
    },
  };
}

/**
 * Choices follow the active map, or the intersection of usable installed maps
 * when no map is active. Unknown lightweight support is disabled, not guessed;
 * the controls and the baseline High/Balanced choices render immediately.
 */
export function useRenderingAvailability(manifestUrl?: string | null): RenderingAvailability {
  const host = useStudioHost();
  const target = useRenderingBenchmarkTarget();
  const scope = manifestUrl ?? target?.manifestUrl ?? "";
  const label = target?.label ?? "This map";
  const [state, setState] = useState<{ scope: string; value: RenderingAvailability }>({ scope: "", value: CHECKING_RENDERING });
  useEffect(() => {
    const abort = new AbortController();
    setState({ scope, value: CHECKING_RENDERING });
    void (async () => {
      const maps = scope ? [{ manifestUrl: scope, label }] : await host.artifacts.listMaps(abort.signal);
      const value = await readRenderingAvailability(maps, abort.signal);
      if (!abort.signal.aborted) setState({ scope, value });
    })().catch(() => {
      if (!abort.signal.aborted) setState({ scope, value: {
        checking: false,
        unavailable: {
          "roads-only": "Map derivatives could not be checked. Roads Only is unavailable.",
          "ultra-low-3d": "Map derivatives could not be checked. Low is unavailable.",
        },
      } });
    });
    return () => abort.abort();
  }, [host, scope, label]);
  return state.scope === scope ? state.value : CHECKING_RENDERING;
}
