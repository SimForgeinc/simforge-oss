"use client";

import { ArrowUpRight, Sparkles } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { CarlaCompatibilityPill } from "@simforge-oss/studio-ui/components/CarlaCompatibilityPill";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import type { GalleryAssetSummary } from "@simforge-oss/studio-ui/lib/asset-gallery/contracts";
import { card } from "./asset-grid.stylex";
import { GALLERY_UPLOAD_CARLA_COMPATIBILITY } from "./gallery-filters";


/** One tile in the local model catalog. */
export function AssetCard({
  asset,
  onSelect,
}: {
  asset: GalleryAssetSummary;
  onSelect: (asset: GalleryAssetSummary) => void;
}) {
  return (
    <button type="button" onClick={() => onSelect(asset)} {...stylex.props(card.root)}>
      <div {...stylex.props(card.well)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived presigned S3 thumbnail; next/image cannot cache a rotating signature */}
        <img
          src={asset.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          {...stylex.props(card.thumbnail)}
        />
        <div {...stylex.props(card.pillSlot)}>
          <CarlaCompatibilityPill compatibility={GALLERY_UPLOAD_CARLA_COMPATIBILITY} size="sm" />
        </div>
        {asset.animated ? (
          <Badge variant="secondary" xstyle={card.animatedBadge}>
            <Sparkles aria-hidden="true" {...stylex.props(card.animatedIcon)} />
            Animated
          </Badge>
        ) : null}
        {/* Hover affordance rather than a permanent "open" chip: the grid is
            scanned, and 24 identical call-to-actions add noise to every scan.
            Hidden from the tree so it does not prefix the tile's accessible
            name — the button role already says the tile is activatable. */}
        <div aria-hidden="true" {...stylex.props(card.reveal)}>
          View details
          <ArrowUpRight aria-hidden="true" {...stylex.props(card.revealIcon)} />
        </div>
      </div>

      <div {...stylex.props(card.body)}>
        <div {...stylex.props(card.titleRow)}>
          <h3 {...stylex.props(card.title)}>{asset.title}</h3>
          <span {...stylex.props(card.classChip)}>
            {asset.actorClass.replaceAll("_", " ")}
          </span>
        </div>
        <div {...stylex.props(card.meta)}>
          <span {...stylex.props(card.metaCount)}>
            {asset.triangleCount.toLocaleString()} tris
          </span>
        </div>
      </div>
    </button>
  );
}
