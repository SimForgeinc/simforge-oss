"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./Map2DOverlay.stylex";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import { MapDetailPageClient } from "@/app/dashboard/map-assets/[mapAssetId]/MapDetailPageClient";
import type { MapTemplateScenarioRow } from "@/app/lib/db/scenario-query-store";
import type { ScenarioSummary } from "@/app/lib/scenarios";
import { a11y } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

export function Map2DOverlay({
  asset,
  allAssets,
  onClose,
  onSwitchMap,
}: {
  asset: MapAsset;
  allAssets: MapAsset[];
  onClose: () => void;
  onSwitchMap: (mapAssetId: string) => void;
}) {
  const [supportingData, setSupportingData] = useState<{
    runs: ScenarioSummary[];
    templateScenarios: MapTemplateScenarioRow[];
  }>({ runs: [], templateScenarios: [] });

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/map-assets/${encodeURIComponent(asset.map_asset_id)}/workspace`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Map workspace data is unavailable.");
        return response.json() as Promise<{
          runs?: ScenarioSummary[];
          templateScenarios?: MapTemplateScenarioRow[];
        }>;
      })
      .then((payload) => {
        setSupportingData({
          runs: payload.runs ?? [],
          templateScenarios: payload.templateScenarios ?? [],
        });
      })
      .catch(() => {
        // The core 2D map remains useful when optional scenario data is unavailable.
      });
    return () => controller.abort();
  }, [asset.map_asset_id]);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay {...stylex.props(styles.dialogOverlay)} />
        <DialogPrimitive.Content
          {...stylex.props(styles.dialogContent)}
          data-testid="map-gallery-2d-overlay"
        >
          <DialogPrimitive.Title {...stylex.props(a11y.srOnly)}>
            {asset.name} 2D map
          </DialogPrimitive.Title>
          <DialogPrimitive.Description {...stylex.props(a11y.srOnly)}>
            Explore road geometry, map layers, search results, and attributes for this map.
          </DialogPrimitive.Description>
          <MapDetailPageClient
            key={asset.map_asset_id}
            asset={asset}
            allAssets={allAssets}
            runs={supportingData.runs}
            initialTemplateScenarios={supportingData.templateScenarios}
            presentation="overlay"
            onClose={onClose}
            onSwitchMap={onSwitchMap}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
