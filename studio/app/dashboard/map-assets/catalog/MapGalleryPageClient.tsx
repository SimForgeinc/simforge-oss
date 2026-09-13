"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CityViewer } from "@simforge-oss/viewer";
import type { ActorRenderer } from "@simforge-oss/viewer";
import {
  DISABLED_SUMO_STATUS,
  type SumoTrafficStatus,
} from "@simforge-oss/playback/traffic";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CarFront,
  Loader2,
  Map as MapIcon,
  MapPin,
  Plus,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import type { MapAsset } from "@simforge-oss/studio-shared";
import type {
  ScenarioDocumentDto,
  ScenarioMapDescriptorDto,
} from "@/app/lib/scenario/contracts";
import { TopBarActionsPortal } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import type { ScenarioMapOption } from "@simforge-oss/studio-ui/scenario/list/document-map-groups";
import { ScenarioMapPickerDialog } from "@simforge-oss/studio-ui/scenario/list/ScenarioMapPickerDialog";
import {
  ScenarioWorldHost,
  type ScenarioWorldState,
  type ScenarioWorldTarget,
} from "@simforge-oss/studio-ui/scenario/scene/ScenarioWorldHost";
import { useIdleStreetTour } from "@simforge-oss/studio-ui/scenario/scene/useIdleStreetTour";
import { LocalMapPreparationPanel } from "@/app/components/LocalMapPreparationPanel";
import type { LocalMapDescriptor } from "@/app/lib/cloud/maps";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";
import { getCardStats } from "./map-card-data";
import { MapGallerySumoTraffic } from "./MapGallerySumoTraffic";

const Map2DOverlay = dynamic(
  () => import("./Map2DOverlay").then((module) => module.Map2DOverlay),
  {
    ssr: false,
    loading: () => (
      <div className={stylex.props(styles.s_211).className} role="status">
        <div className={stylex.props(styles.s_212).className}>
          <Loader2 className={stylex.props(styles.s_213).className} />
          Loading 2D map…
        </div>
      </div>
    ),
  },
);

type GalleryEntry = {
  map: LocalMapDescriptor;
  asset: MapAsset | null;
};

const EMPTY_WORLD_STATE: ScenarioWorldState = {
  target: null,
  loadedMapVersionId: null,
  streaming: false,
  error: null,
};

/** Reuses the persistent Datasets world and its topology-bound street tour. */
function MapGalleryWorldPreview({
  map,
  sumoEnabled,
  onSumoStatusChange,
}: {
  map: ScenarioMapDescriptorDto;
  sumoEnabled: boolean;
  onSumoStatusChange: (status: SumoTrafficStatus) => void;
}) {
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [actorRenderer, setActorRenderer] = useState<ActorRenderer | null>(null);
  const [worldState, setWorldState] = useState<ScenarioWorldState>(EMPTY_WORLD_STATE);
  const target = useMemo<ScenarioWorldTarget>(() => ({
    mapVersionId: map.mapVersionId,
    manifestUrl: map.browserManifestUrl,
    label: map.label,
    locality: map.locality,
  }), [map.browserManifestUrl, map.label, map.locality, map.mapVersionId]);
  const tourMap = useMemo<ScenarioMapOption>(() => ({
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    label: map.label,
    locality: map.locality,
    browserManifestUrl: map.browserManifestUrl,
    topologyUrl: map.topologyArtifactUrl,
  }), [map]);

  useIdleStreetTour({
    enabled: true,
    interruptible: false,
    map: tourMap,
    viewer,
    loadedMapVersionId: worldState.loadedMapVersionId,
    cinematic: true,
    speedMultiplier: 1.5,
    allowLookAround: true,
  });

  return (
    <>
      <ScenarioWorldHost
        className={stylex.props(styles.s_214).className}
        interactive
        onActorRendererChange={setActorRenderer}
        onStateChange={setWorldState}
        onViewerChange={setViewer}
        target={target}
      />
      <MapGallerySumoTraffic
        actorRenderer={actorRenderer}
        enabled={sumoEnabled}
        loadedMapVersionId={worldState.loadedMapVersionId}
        map={map}
        onStatusChange={onSumoStatusChange}
        viewer={viewer}
      />
    </>
  );
}

function AddMapTopBarAction() {
  return (
    <TopBarActionsPortal>
      <Button asChild size="sm">
        <Link href="/dashboard/map-assets/new">
          <Plus className={stylex.props(styles.s_847).className} />
          Add map
        </Link>
      </Button>
    </TopBarActionsPortal>
  );
}

function mapLocation(entry: GalleryEntry) {
  const place = entry.asset?.place_context;
  const detailed = [place?.city, place?.state].filter(Boolean).join(", ");
  return detailed || entry.map.locality || place?.country || "Simulation-ready digital twin";
}

function MapArrow({
  direction,
  targetLabel,
  disabled,
  onClick,
}: {
  direction: "previous" | "next";
  targetLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${direction === "previous" ? "Previous" : "Next"} map: ${targetLabel}`}
      className={stylex.props(styles.s_216).className}
    >
      <Icon className={stylex.props(styles.s_251).className} />
    </button>
  );
}

export function MapGalleryPageClient({
  assets,
  maps,
}: {
  assets: MapAsset[];
  maps: LocalMapDescriptor[];
}) {
  const router = useRouter();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [map2DOpen, setMap2DOpen] = useState(false);
  const [mapPickerOpen, setMapPickerOpen] = useState(false);
  const [sumoEnabled, setSumoEnabled] = useState(false);
  const [sumoStatus, setSumoStatus] = useState<SumoTrafficStatus>(DISABLED_SUMO_STATUS);
  const cloudState = useStudioCloudStatus().status?.state;
  useEffect(() => {
    if (cloudState && cloudState !== "connecting") router.refresh();
  }, [cloudState, router]);

  const entries = useMemo<GalleryEntry[]>(() => {
    const assetsById = new Map(assets.map((asset) => [asset.map_asset_id, asset]));
    return [...maps]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((map) => ({ map, asset: assetsById.get(map.sourceMapId) ?? null }));
  }, [assets, maps]);

  const move = useCallback(
    (offset: number) => {
      if (entries.length < 2) return;
      setSelectedIndex((current) => (current + offset + entries.length) % entries.length);
    },
    [entries.length],
  );

  const switchOverlayMap = useCallback((mapAssetId: string) => {
    const nextIndex = entries.findIndex((candidate) => candidate.asset?.map_asset_id === mapAssetId);
    if (nextIndex >= 0) setSelectedIndex(nextIndex);
  }, [entries]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (map2DOpen || mapPickerOpen) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select") ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [map2DOpen, mapPickerOpen, move]);

  useEffect(() => {
    if (entries.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const adjacent = new Set(
        [
          entries[(selectedIndex - 1 + entries.length) % entries.length],
          entries[(selectedIndex + 1) % entries.length],
        ].map((candidate) => (!candidate?.map.installed.browser || candidate.map.locked || (candidate.map.access === "cloud" && cloudState !== "connected") ? null : candidate.map.browserManifestUrl)),
      );
      for (const manifestUrl of adjacent) {
        if (!manifestUrl) continue;
        void fetch(manifestUrl, { cache: "force-cache", signal: controller.signal }).catch(() => undefined);
      }
    }, 1_200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [entries, selectedIndex, cloudState]);

  if (entries.length === 0) {
    return (
      <>
        <AddMapTopBarAction />
        <EmptyState
          icon={<MapPin className={stylex.props(styles.s_946).className} />}
          title="No maps yet"
          description="Upload your first map to explore it in 3D and create simulation scenarios."
          action={
            <Button asChild>
              <Link href="/dashboard/map-assets/new">
                <Plus className={stylex.props(styles.s_219).className} />
                Add map
              </Link>
            </Button>
          }
          xstyle={styles.s_220}
        />
      </>
    );
  }

  const entry = entries[Math.min(selectedIndex, entries.length - 1)]!;
  const previous = entries[(selectedIndex - 1 + entries.length) % entries.length]!;
  const next = entries[(selectedIndex + 1) % entries.length]!;
  const stats = entry.asset ? getCardStats(entry.asset).slice(0, 3) : [];
  const sumoAvailable = Boolean(entry.map.sumoNetworkSha256);
  const sumoLoading = sumoEnabled && sumoAvailable && sumoStatus.phase === "loading";
  const sumoFailed = sumoEnabled && sumoStatus.phase === "fallback";
  const locked = entry.map.access === "cloud" ? cloudState !== "connected" : entry.map.locked;

  const createScenario = async () => {
    if (creating || locked || !entry.map.installed.browser) return;
    setCreating(true);
    try {
      const response = await fetch(
        `/api/simforge/maps/${encodeURIComponent(entry.map.mapVersionId)}/documents/default`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => null)) as
        | { document?: ScenarioDocumentDto; error?: string }
        | null;
      if (!response.ok || !payload?.document) {
        throw new Error(payload?.error || "The scenario could not be created.");
      }
      router.push(
        `/dashboard/scenario?dataset=${encodeURIComponent(payload.document.datasetId)}&document=${encodeURIComponent(payload.document.id)}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The scenario could not be created.");
      setCreating(false);
    }
  };

  return (
    <>
      <AddMapTopBarAction />
      <main className={stylex.props(styles.s_221).className}>
        <div className={stylex.props(styles.s_801).className}>
          {locked || !entry.map.installed.browser ? (
            // Do not mount a viewer before its local closure is installed and authorized.
            <div
              className={stylex.props(styles.s_223).className}
              data-testid={locked ? "map-gallery-locked-backdrop" : "map-gallery-uninstalled-backdrop"}
            />
          ) : (
            <MapGalleryWorldPreview
              map={entry.map}
              onSumoStatusChange={setSumoStatus}
              sumoEnabled={sumoEnabled}
            />
          )}
        </div>

        <div className={stylex.props(styles.s_224).className} />
        <div className={stylex.props(styles.s_225).className} />

        <div className={stylex.props(styles.s_226).className}>
          <button
            type="button"
            aria-label={sumoAvailable ? `SUMO traffic ${sumoEnabled ? "on" : "off"}` : "SUMO traffic unavailable"}
            aria-pressed={sumoAvailable ? sumoEnabled : undefined}
            className={stylex.props(
              styles.sumoToggle,
              sumoEnabled && sumoAvailable ? styles.sumoToggleOn : styles.sumoToggleOff,
              !sumoAvailable && styles.sumoToggleUnavailable,
            ).className}
            disabled={!sumoAvailable}
            onClick={() => setSumoEnabled((enabled) => !enabled)}
            title={
              !sumoAvailable
                ? "This map does not publish a SUMO traffic network."
                : sumoFailed
                  ? sumoStatus.reason ?? "SUMO traffic could not start."
                  : "Show continuously running browser SUMO traffic"
            }
          >
            {sumoLoading ? (
              <Loader2 aria-hidden="true" className={stylex.props(styles.s_254).className} />
            ) : sumoFailed ? (
              <AlertTriangle aria-hidden="true" className={stylex.props(styles.s_847).className} />
            ) : (
              <CarFront aria-hidden="true" className={stylex.props(styles.s_847).className} />
            )}
            <span>
              {!sumoAvailable
                ? "SUMO unavailable"
                : sumoFailed
                  ? "SUMO error"
                  : `SUMO ${sumoEnabled ? "on" : "off"}`}
            </span>
            {sumoEnabled && sumoStatus.actorCount > 0 ? (
              <span className={stylex.props(styles.s_230).className}>{sumoStatus.actorCount}</span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setMap2DOpen(true)}
            disabled={!entry.asset}
            className={stylex.props(styles.s_231).className}
            title={entry.asset ? "Open the 2D map workspace" : "No 2D map is available for this digital twin"}
          >
            <MapIcon aria-hidden="true" className={stylex.props(styles.s_232).className} />
            View 2D map
          </button>
        </div>
        <div
          aria-hidden="true"
          className={stylex.props(styles.s_233, styles.diagonalVeilMask).className}
          data-testid="map-gallery-diagonal-veil"
        />

        <section
          className={stylex.props(styles.s_234).className}
          data-testid="map-gallery-editorial-overlay"
        >
          <div className={stylex.props(styles.s_235).className}>
            <div className={stylex.props(styles.s_236).className}>
              <p className={stylex.props(styles.s_237).className}>
                <Sparkles aria-hidden="true" className={stylex.props(styles.s_991).className} />
                Simulation-ready digital twin
              </p>
              <h1
                className={stylex.props(styles.s_239, styles.heroTitleShadow).className}
              >
                {entry.map.label}
              </h1>
              <p className={stylex.props(styles.s_240).className}>
                <MapPin aria-hidden="true" className={stylex.props(styles.s_241).className} />
                {mapLocation(entry)}
              </p>
              {entry.asset?.description ? (
                <p className={stylex.props(styles.s_242).className}>
                  {entry.asset.description}
                </p>
              ) : null}
              <div className={stylex.props(styles.s_243).className}>
                {stats.map((stat) => (
                  <span className={stylex.props(styles.s_940).className} key={stat.key} title={stat.tooltip}>{stat.value}</span>
                ))}
                {entry.asset ? (
                  <Link
                    href={`/dashboard/map-assets/${encodeURIComponent(entry.asset.map_asset_id)}`}
                    className={stylex.props(styles.s_245).className}
                  >
                    View map details
                    <ArrowUpRight aria-hidden="true" className={stylex.props(styles.s_991).className} />
                  </Link>
                ) : null}
              </div>
              <LocalMapPreparationPanel xstyle={styles.s_247} map={entry.map} />
            </div>

            <div className={stylex.props(styles.s_248).className}>
              <div className={stylex.props(styles.s_908).className}>
                <MapArrow
                  direction="previous"
                  targetLabel={previous.map.label}
                  disabled={entries.length < 2}
                  onClick={() => move(-1)}
                />
                <button
                  aria-label="Choose a map"
                  className={stylex.props(styles.s_250).className}
                  onClick={() => setMapPickerOpen(true)}
                  title="Open map gallery"
                  type="button"
                >
                  <MapIcon aria-hidden="true" className={stylex.props(styles.s_251).className} />
                </button>
                <MapArrow
                  direction="next"
                  targetLabel={next.map.label}
                  disabled={entries.length < 2}
                  onClick={() => move(1)}
                />
                <span className={stylex.props(styles.s_252).className}>
                  {String(selectedIndex + 1).padStart(2, "0")} / {String(entries.length).padStart(2, "0")}
                </span>
              </div>

              <Button
                type="button"
                size="lg"
                onClick={createScenario}
                disabled={creating || locked || !entry.map.installed.browser}
                title={locked ? "Connect to SimCloud to author on this map." : !entry.map.installed.browser ? "Prepare this map on this computer first." : undefined}
                xstyle={styles.s_253}
              >
                {creating ? <Loader2 className={stylex.props(styles.s_254).className} /> : null}
                <span>{creating ? "Creating scenario…" : "Create scenario"}</span>
                {!creating ? <ArrowRight aria-hidden="true" className={stylex.props(styles.s_847).className} /> : null}
              </Button>
            </div>
          </div>
        </section>
      </main>
      {map2DOpen && entry.asset ? (
        <Map2DOverlay
          asset={entry.asset}
          allAssets={entries.flatMap((candidate) => candidate.asset ? [candidate.asset] : [])}
          onClose={() => setMap2DOpen(false)}
          onSwitchMap={switchOverlayMap}
        />
      ) : null}
      <ScenarioMapPickerDialog
        currentMapVersionId={entry.map.mapVersionId}
        maps={entries.map((candidate) => candidate.map)}
        onOpenChange={setMapPickerOpen}
        onSelectMap={(selectedMap) => {
          const nextIndex = entries.findIndex(
            (candidate) => candidate.map.mapVersionId === selectedMap.mapVersionId,
          );
          if (nextIndex >= 0) setSelectedIndex(nextIndex);
        }}
        open={mapPickerOpen}
      />
    </>
  );
}
