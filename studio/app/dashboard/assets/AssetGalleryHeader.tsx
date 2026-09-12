"use client";

import { Boxes, Map as MapIcon, Sparkles, Upload } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { PageHeader } from "@simforge-oss/studio-ui/components/ui/page-header";
import { header } from "./asset-gallery.stylex";
import { AssetGallerySegmented } from "./AssetGallerySegmented";

/** The two things this library holds. Models and maps share nothing but the shelf. */
export type GallerySection = "models" | "maps";

const SECTION_OPTIONS = [
  { value: "models", label: "Models", icon: Boxes },
  { value: "maps", label: "Maps", icon: MapIcon },
] as const;

const SECTION_DESCRIPTION = {
  models:
    "Scenario-ready 3D models stored in the local library.",
  maps: "Local map versions available for scenario authoring.",
} as const satisfies Record<GallerySection, string>;

export function AssetGalleryHeader({
  section,
  onSectionChange,
  onGenerate,
  onUpload,
}: {
  section: GallerySection;
  onSectionChange: (section: GallerySection) => void;
  onGenerate: () => void;
  onUpload: () => void;
}) {
  return (
    <div {...stylex.props(header.bar)}>
      <div {...stylex.props(header.measure)}>
        {/* `PageHeader` is still a Tailwind component and its own base classes
            win over StyleX by design — the generated sheet is ordered weaker
            so unmigrated callers keep rendering unchanged. Its frame is
            stripped here, so these overrides have to stay Tailwind to beat
            it. They move when `PageHeader` itself does. */}
        <PageHeader
          className="border-b-0 bg-transparent px-0 pb-4 sm:px-0"
          eyebrow="Local library"
          title="Assets"
          description={SECTION_DESCRIPTION[section]}
          actions={
            <div {...stylex.props(header.actions)}>
              {section === "models" ? (
                <Button type="button" onClick={onGenerate}>
                  <Sparkles aria-hidden="true" />
                  Generate model
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={onUpload}>
                <Upload aria-hidden="true" />
                {section === "maps" ? "Import map" : "Import model"}
              </Button>
            </div>
          }
        />
        <AssetGallerySegmented
          label="Library section"
          value={section}
          options={SECTION_OPTIONS}
          onChange={onSectionChange}
          xstyle={header.sectionSwitch}
        />
      </div>
    </div>
  );
}
