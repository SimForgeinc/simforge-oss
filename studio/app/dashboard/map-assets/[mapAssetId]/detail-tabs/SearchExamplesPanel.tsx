"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./SearchExamplesPanel.stylex";

import { SEARCH_EXAMPLE_GROUPS, type SearchExample } from "./search-examples";
import { motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

interface SearchExamplesPanelProps {
  /** Submit a query — usually the page's `onSubmitSearch`. Available-tier
   *  examples call this; coming-soon chips are muted and non-interactive. */
  onRunExample: (query: string) => void;
}

/**
 * Empty-state panel shown below the search input when no query is active.
 * The panel *is* the tutorial: each chip is a one-click demo of a supported
 * query shape. Groups are rendered in roadmap order so `available` rows
 * come first and `coming soon` rows sit below as aspirational teases.
 */
export function SearchExamplesPanel({ onRunExample }: SearchExamplesPanelProps) {
  return (
    <div {...stylex.props(styles.searchExamplesPanel)}>
      {SEARCH_EXAMPLE_GROUPS.map((group) => (
        <section key={group.id} {...stylex.props(styles.exampleGroup)}>
          <header {...stylex.props(styles.groupHeader)}>
            <h3 {...stylex.props(styles.groupTitle)}>
              {group.title}
            </h3>
            {group.tier === "coming_soon" ? (
              <span {...stylex.props(styles.comingSoonBadge)}>
                Coming soon
              </span>
            ) : null}
          </header>
          <div {...stylex.props(styles.exampleChipList)}>
            {group.examples.map((example) => (
              <Chip key={example.label} example={example} onRun={onRunExample} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface ChipProps {
  example: SearchExample;
  onRun: (query: string) => void;
}

function Chip({ example, onRun }: ChipProps) {
  const isAvailable = example.tier === "available";
  return (
    <button
      type="button"
      disabled={!isAvailable}
      onClick={() => isAvailable && onRun(example.query)}
      {...stylex.props([motionRecipe.colors, styles.examplePill], isAvailable ? styles.examplePillAvailable : styles.examplePillUnavailable)}
      title={isAvailable ? `Run search: ${example.query}` : "Coming in the next release"}
    >
      {example.label}
    </button>
  );
}
