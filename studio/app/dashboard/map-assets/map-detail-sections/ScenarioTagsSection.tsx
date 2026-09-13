"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { ChevronRight, Check, Copy } from "lucide-react";
import { getMapAssetDescriptorTag } from "@simforge-oss/studio-shared";

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
      <div className={stylex.props(styles.s_961).className}>
        <button
          type="button"
          onClick={onToggleOpen}
          className={stylex.props(styles.s_962).className}
          aria-expanded={open}
        >
          <ChevronRight
            className={stylex.props(styles.chevron, open && styles.rotate90).className}
          />
          Scenario tags ({tags.length})
        </button>
        <button
          type="button"
          onClick={() => onCopy(tags.join(","), "tags")}
          aria-label="Copy tags as CSV"
          title="Copy tags as CSV"
          className={stylex.props(styles.s_713).className}
        >
          {copiedKey === "tags" ? <Check className={stylex.props(styles.s_714).className} /> : <Copy className={stylex.props(styles.s_927).className} />}
        </button>
      </div>
      {open && (
        <ul className={stylex.props(styles.s_819).className}>
          {tags.map((tagId) => {
            const descriptor = getMapAssetDescriptorTag(tagId);
            return (
              <li key={tagId} className={stylex.props(styles.s_563).className}>
                <p className={stylex.props(styles.s_814).className}>{tagId.replace(/_/g, " ")}</p>
                {descriptor?.shortDefinition && (
                  <p className={stylex.props(styles.s_565).className}>
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
