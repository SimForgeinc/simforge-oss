"use client";

import * as stylex from "@stylexjs/stylex";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import {
  readRenderingPreference,
  saveRenderingPreference,
  type RenderingPreference,
} from "@simforge-oss/studio-ui/components/rendering-preference";
import { MapAssetCacheStorage } from "@simforge-oss/studio-ui/components/MapAssetCacheStorage";
import type { ScenarioMapOption } from "@simforge-oss/studio-ui/scenario/list/document-map-groups";
import { studioHost } from "@/app/lib/host";
import { styles } from "@/app/components/render-settings.stylex";
import type { RenderSettingsProps } from "@/app/host/contract";

/**
 * Render Settings on a cloud host: the render selection, and what this browser
 * is holding.
 *
 * The quality here is a preference of THIS BROWSER — the viewport picks texture
 * tiers with it — not a profile prepared on a machine. There is no library to
 * download ahead of time, so the local host's map preparation, its profile
 * switch dialog and its "delete cache and re-download" are all absent rather
 * than disabled: maps stream from object storage and the browser's own cache
 * fills and evicts itself. What remains worth showing is how much of this
 * browser's storage that cache is currently using.
 */

const RenderSelectionPanel = dynamic(
  () =>
    import("@simforge-oss/studio-ui/render-selection/RenderSelectionPanel").then(
      (module) => module.RenderSelectionPanel,
    ),
  { ssr: false },
);

export function RenderSettings({ onDone }: RenderSettingsProps) {
  const [currentQuality, setCurrentQuality] = useState<RenderingPreference | null>(null);
  const [benchmarkTarget, setBenchmarkTarget] = useState<ScenarioMapOption | null>(null);
  const [benchmarkCatalogReady, setBenchmarkCatalogReady] = useState(false);

  useEffect(() => setCurrentQuality(readRenderingPreference()), []);

  useEffect(() => {
    const controller = new AbortController();
    void studioHost.artifacts
      .listMaps(controller.signal)
      .then((maps) => {
        if (controller.signal.aborted) return;
        setBenchmarkTarget(maps.find((map) => Boolean(map.browserManifestUrl)) ?? null);
        setBenchmarkCatalogReady(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBenchmarkCatalogReady(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <div {...stylex.props(styles.root)} data-testid="render-settings-panel">
      <RenderSelectionPanel
        manifestUrl={benchmarkTarget?.browserManifestUrl ?? null}
        mapLabel={benchmarkTarget?.label ?? "Current map"}
        catalogReady={benchmarkCatalogReady}
        currentQuality={currentQuality ?? "low"}
        onChoose={(quality) => {
          saveRenderingPreference(quality);
          setCurrentQuality(quality);
        }}
        titleId="render-settings-title"
        descriptionId="render-settings-description"
        footer={
          <div {...stylex.props(styles.footer)}>
            <MapAssetCacheStorage allowClear={false} refreshKey={currentQuality} />
            <div {...stylex.props(styles.footerRow)}>
              <Button onClick={onDone} type="button" variant="outline" xstyle={styles.cacheButton}>
                Done
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
