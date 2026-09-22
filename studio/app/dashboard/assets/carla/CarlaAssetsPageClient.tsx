"use client";

import * as stylex from "@stylexjs/stylex";
import { plate } from "@/app/components/AppStage.stylex";
import { AppStage } from "@/app/components/AppStage";
import { AssetsTabs } from "../AssetsTabs";
import { CarlaCompatibilityTable, type CarlaCompatibilityRow } from "./CarlaCompatibilityTable";

export function CarlaAssetsPageClient({ rows, counts, version }: {
  rows: CarlaCompatibilityRow[];
  counts: { objects: number; equivalents: number; unavailable: number };
  version: string;
}) {
  return (
    <AppStage fill title="CARLA compatibility" eyebrow="Assets" testId="carla-assets">
      <div {...stylex.props(plate.scroller)}>
        <div>
          <AssetsTabs />
          <p {...stylex.props(plate.copy)}>{counts.objects.toLocaleString()} objects · {counts.equivalents.toLocaleString()} bound ids · {counts.unavailable.toLocaleString()} fail-closed · CARLA {version}</p>
        </div>
      <CarlaCompatibilityTable rows={rows} />
      </div>
    </AppStage>
  );
}
