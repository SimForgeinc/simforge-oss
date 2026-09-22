"use client";

import { Boxes, Map as MapIcon } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { header } from "./AssetGalleryHeader.stylex";
import { AssetGallerySegmented } from "./AssetGallerySegmented";

export type GallerySection = "models" | "maps";
const SECTION_OPTIONS = [
  { value: "models", label: "Models", icon: Boxes },
  { value: "maps", label: "Maps", icon: MapIcon },
] as const;

export function AssetGalleryHeader({ section, onSectionChange }: {
  section: GallerySection;
  onSectionChange: (section: GallerySection) => void;
}) {
  return <div {...stylex.props(header.section)}>
    <AssetGallerySegmented label="Library section" value={section} options={SECTION_OPTIONS} onChange={onSectionChange} />
  </div>;
}
