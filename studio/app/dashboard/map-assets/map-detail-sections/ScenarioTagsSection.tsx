"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioTagsSection.stylex";

import { ChevronRight, Check, Copy } from "lucide-react";
import { getMapAssetDescriptorTag } from "@simforge-oss/studio-shared";
import { motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

/** Props for the ScenarioTagsSection component. */
type ScenarioTagsSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  tags: string[];
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
};

/** Display scenario descriptor tags with definitions in a collapsible list. */
export function ScenarioTagsSection({
  open,
  onToggleOpen,
  tags,
  copiedKey,
  onCopy,
}: ScenarioTagsSectionProps) {
  return (
    <section>
      <div {...stylex.props(styles.tagsHeader)}>
        <button
          type="button"
          onClick={onToggleOpen}
          {...stylex.props([motionRecipe.colors, styles.toggleButton])}
          aria-expanded={open}
        >
          <ChevronRight
            {...stylex.props([motionRecipe.transform, styles.chevron], open && styles.rotate90)}
          />
          Scenario tags ({tags.length})
        </button>
        <button
          type="button"
          onClick={() => onCopy(tags.join(","), "tags")}
          aria-label="Copy tags as CSV"
          title="Copy tags as CSV"
          {...stylex.props([motionRecipe.colors, styles.copyButton])}
        >
          {copiedKey === "tags" ? <Check {...stylex.props(styles.checkIcon)} /> : <Copy {...stylex.props(styles.copyIcon)} />}
        </button>
      </div>
      {open && (
        <ul {...stylex.props(styles.tagsList)}>
          {tags.map((tagId) => {
            const descriptor = getMapAssetDescriptorTag(tagId);
            return (
              <li key={tagId} {...stylex.props(styles.tagItem)}>
                <p {...stylex.props(styles.tagLabel)}>{tagId.replace(/_/g, " ")}</p>
                {descriptor?.shortDefinition && (
                  <p {...stylex.props(styles.tagDefinition)}>
                    {descriptor.shortDefinition}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
